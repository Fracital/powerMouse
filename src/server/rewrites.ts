import {
	BareCompatibleClient,
	type ProxyTransport,
} from '@mercuryworkshop/proxy-transports';
import { acceptLanguage } from '../acceptLanguage';
import GenericCodec from '../Codecs';
import { codecType, Config, ParsedConfig } from '../config';
import { freshFrameDocument } from '../freshFrame';
import { rewriteLinkHeader } from '../headers';
import { helperNames } from '../helperNames';
import {
	delegatedTo,
	embedderPolicy,
	embedderPolicyBlocks,
	embedderRefuses,
	isolationFacts,
	isolationHeaders,
	isolationResponseHeaders,
	nestedIsolation,
	topLevelIsolation,
	type DocumentIsolation,
} from '../isolation';
import {
	insecure,
	metaUpgradesInsecureRequests,
	mixedContentVerdict,
	potentiallyTrustworthy,
	restrictsMixedContent,
	upgradedURL,
	upgradesInsecureRequests,
} from '../mixedContent';
import {
	kindPartition,
	nestedMark,
	parseNestedMark,
	partitionSite,
	siteOf,
	workerKindPartition,
} from '../partition';
import {
	hasBase,
	inlineSources,
	packRewrite,
	scriptPreamble,
	type Prewritten,
} from '../prewrite';
import {
	DEFAULT_REFERRER_POLICY,
	refererFor,
	type ReferrerInfo,
} from '../referrerPolicy';
import {
	modifyCSS,
	rewriteCSSValueURLs,
	routeCSS,
	type StyleRewrittenBy,
} from '../rewriteCSS';
import {
	modifyHTML,
	modifyHTMLStreamed,
	modifyRefresh,
	modifyXML,
	nestedMarkOf,
	nestedMarkOfKind,
	nestedTopOf,
	routeHTML,
	XML_DOCUMENT_MIMES,
} from '../rewriteHTML';
import { modifyJS, RewrittenBy, routeJS, ScriptType } from '../rewriteJS';
import {
	linkRouteURL,
	parseRoutedURL,
	routeBinary,
	unwrapRoute,
} from '../routeURL';
import type { ControlInfo } from '../serviceWorkerTypes';
import { siteFacts, type SiteFacts } from '../siteFacts';
import StompURL from '../StompURL';
import { getDomain, getPublicSuffix } from '../suffix';
import type {
	HostReload,
	RequestErrorKind,
	RequestInfo,
	RequestRule,
	RouteContext,
} from '../transport/messages';
import {
	ABORT_HEADER,
	CACHED_MARKER,
	CREDENTIALS_HEADER,
	HOPS_MARKER,
	KEPT_MARKER,
	LOAD_HEADER,
	MEMORY_MARKER,
	OPAQUE_COPY_HEADER,
	OPAQUE_HEADER,
	OPAQUE_MARKER,
	PREFLIGHT_HEADER,
	RESPONSE_TYPE_HEADER,
	REVALIDATED_MARKER,
	SEALER_ROUTE,
	TAO_MARKER,
	TIMING_ONLY_MARKER,
	XHR_MARKER,
} from '../transport/messages';
import { fragmentOf, queryOf, withQuery } from '../urlShape';
import { BUILD } from '../version';
import { contextText, isLinkRoute, LINK_SEGMENT, linkRoute } from '../visited';
import { scanMarkup, scannerSettled } from '../wasm/scanner';
import {
	knownOriginOf,
	knownTopSiteOf,
	recordInlineOrigin,
} from './blobOrigins';
import type { Blocker } from './blocker';
import {
	askedRange,
	byteRange,
	clearsCache,
	contentRange,
	HttpCache,
	isCacheable,
	isPartCacheable,
	mayKeep,
	MEMORY_DESTINATIONS,
	MemoryCache,
	memoryCache,
	parseCacheControl,
	partitionedKey,
	sameVersion,
	type CacheHit,
} from './cache';
import { decodeDocument, utf8ContentType } from './charset';
import {
	acceptedHints,
	applyClientHints,
	applyMeta,
	browserPolicy,
	criticalRetry,
	hintsDocument,
	persistAcceptCH,
	recordDocument as recordHintsDocument,
	topDocument,
	type HintsContext,
} from './clientHints';
import Cookies from './Cookies';
import {
	corpBlocks,
	corsCheck,
	exposedHeaders,
	needsPreflight,
	preflightAllows,
	preflightCached,
	timingAllowed,
	unsafeHeaderNames,
} from './cors';
import { embedderPolicyOf, rememberEmbedderPolicy } from './embedderPolicies';
import { DOCUMENT_DESTINATIONS, hostErrorPage } from './errorPage';
import {
	AdditionalFilter,
	filterNativeRequestHeaders,
	filterResponseHeaders,
	RouteTransform,
} from './filterHeaders';
import { chromeOrderedHeaders, type RequestShape } from './headerOrder';
import {
	authorizationAhead,
	authorizationForRealm,
	basicAuthorization,
	basicRealm,
	rememberAuthorization,
} from './httpAuth';
import { takeInline } from './inline';
import { formFields, insecureFormPage } from './insecureForm';
import {
	postNotices,
	rememberUpgradeInsecure,
	upgradesInsecure,
} from './insecureRequests';
import { noteKeptLoad } from './keptLoads';
import { takeLoadGrant } from './loadGrants';
import { recordCrossedMedia } from './mediaLoads';
import {
	awaitNavigationHint,
	NavigationHint,
	takeNavigationHint,
} from './navigationHints';
import {
	ORB_SNIFF_BYTES,
	orbByHeaders,
	orbMedia,
	orbSniff,
	peekBody,
} from './orb';
import type { RewriteCache, RewriteCacheOutcome } from './rewriteCache';
import type { RewritePool } from './rewritePool';
import Router from './Router';
import { applyHeaderRule, CompiledRule, compileRules } from './rules';
import { serviceWorkers } from './serviceWorkers';
import { boundClient } from './srcdocVouches';
import { rememberVisitedHop, takeVisitedHop } from './visitedHops';

export const statusEmpty = [101, 204, 205, 304];

const integrityHeaders: string[] = ['Content-MD5'];

declare const clients: Clients | undefined;

/** the real URL a request is reported as: without the `#url(...)` fragment the CSS rewriter keeps for idempotence */
function reportURL(url: StompURL): string {
	const text = url.toString();
	const marker = text.indexOf('#url(');
	return marker === -1 ? text : text.slice(0, marker);
}

type Site = 'none' | 'same-origin' | 'same-site' | 'cross-site';

/**
 * The fetch-metadata site between two real URLs, as Chrome decides it:
 * schemeful (http and https of one domain are cross-site), by registrable
 * domain with the private registries (two github.io pages are cross-site);
 * an IP or localhost has no registrable domain, so the host is the site.
 */
export function siteBetween(
	from: URL,
	to: URL,
): 'same-origin' | 'same-site' | 'cross-site' {
	if (from.origin === to.origin) return 'same-origin';
	if (from.protocol !== to.protocol) return 'cross-site';
	const domain = getDomain(from.hostname, true);
	return (domain !== null && domain === getDomain(to.hostname, true)) ||
		from.hostname === to.hostname
		? 'same-site'
		: 'cross-site';
}

/** the more distant of two sites ('none' counts as the closest) */
function widestSite(a: string, b: Site): Site {
	const order: Site[] = ['none', 'same-origin', 'same-site', 'cross-site'];
	return order[Math.max(order.indexOf(a as Site), order.indexOf(b))];
}

const FETCH_METADATA = [
	'sec-fetch-dest',
	'sec-fetch-mode',
	'sec-fetch-site',
	'sec-fetch-user',
];

// Chrome sends fetch metadata to potentially trustworthy URLs only: https
// (and wss), and the loopback hosts it treats as secure. A plain http
// origin anywhere else gets none (potentiallyTrustworthy, src/mixedContent.ts)

/**
 * The real URL of each service worker client, by id: a request's origin is
 * its client's (a stylesheet's font, a module's import and a worker's fetch
 * all come from the document or worker that started them), while the
 * Referer names the stylesheet or module. A client keeps its origin for
 * life (pushState cannot change it), so one lookup per client is enough.
 */
const clientURLs = new Map<string, URL>();
/** each client's routed URL, beside its real one: the route kind names its proxied top */
const clientRoutes = new Map<string, string>();
/** the top-level site of a client whose URL names none (a partitioned blob: worker's, an inline document's) */
const clientTopSites = new Map<string, string>();
/**
 * What this worker gave each site's documents since it started, by the
 * memory cache's key (fresh or not, which MemoryCache does not keep): a
 * renderer that has a resource revalidates it itself, and its timing reads
 * as the network's 304 rather than the HTTP cache's (messages.ts Delivery)
 */
const rendererHas = new Set<string>();
/**
 * the conditional request headers: a request that carries one of its page's
 * own is not the HTTP cache's to answer (the browser's own, for what its
 * memory cache holds, are dropped before)
 */
const OWN_CONDITIONALS = [
	'if-none-match',
	'if-modified-since',
	'if-match',
	'if-unmodified-since',
	'if-range',
];
const RENDERER_HAS = 8192;
const CLIENT_URLS_KEPT = 256;

/**
 * Redirects in flight. The browser follows a redirect this worker answered
 * as a new fetch event in proxy URL space, where every hop is same-origin
 * and the referrer never narrows: only this says the chain already went
 * through another origin. Each redirect leaves what it decided under its
 * client (none for a navigation), the request's own (proxy space) referrer
 * and the URL the browser asks for next: the referrer it sent, when it
 * knew one (the next hop narrows from it, in the Referer header and in
 * document.referrer), and its Sec-Fetch-Site (the widest site of the chain
 * carries on). Taken once; kept a minute at most.
 */
interface RedirectHop {
	/** the Referer this hop sent (null: none); absent when it was unknown */
	referer?: string | null;
	site: Site;
	/** the chain began under user activation (Sec-Fetch-User) */
	user?: boolean;
	/** the origin that started the chain, when only a hint named it (a later hop has no referrer either) */
	initiator?: string;
	/**
	 * the chain went from another origin to a third: the request's origin is
	 * "null" from here on (the fetch spec's tainted origin)
	 */
	tainted?: boolean;
	/**
	 * a hop of the chain was of another origin than its initiator's: a no-cors
	 * response at its end is opaque whatever origin that end is of (the fetch
	 * spec's response tainting)
	 */
	crossed?: boolean;
	/**
	 * the chain is a load the inject copies for a page, under a grant its
	 * first hop took (loadGrants.ts): the browser repeats the token on every
	 * hop, and a hop that carries the same one is the same load
	 */
	grant?: { token: string; load: string };
	/** the routed URL the chain began at */
	first?: string;
}

/** the destinations and modes a LOAD_HEADER may name: a page's subresource loads, never a navigation */
const LOAD_DESTINATIONS = [
	'image',
	'script',
	'style',
	'font',
	'audio',
	'video',
	'track',
	// an <embed>'s or <object>'s resource, which the inject loads as a copy
	'embed',
	'object',
];
const LOAD_MODES = ['no-cors', 'cors'];
/**
 * An object's or embed's resource, which Chrome loads as a nested context,
 * goes as `navigate` too. Taken for those two destinations only: the worker
 * decides everything a navigation changes from the real request's mode, and
 * a site's isolation policy treats an object's or embed's navigation as
 * none, so a page that names it on a fetch of its own gains nothing
 */
const LOAD_NAVIGATIONS = ['embed', 'object'];

/**
 * The load a grant named (the value the inject announced for a request
 * that carries its token in LOAD_HEADER, loadGrants.ts), or null
 */
function loadOf(
	value: string | null,
): { destination: string; mode: string } | null {
	const [destination, mode, ...rest] = (value ?? '').trim().split(/\s+/);
	if (rest.length || !LOAD_DESTINATIONS.includes(destination)) return null;
	if (
		!LOAD_MODES.includes(mode) &&
		!(mode === 'navigate' && LOAD_NAVIGATIONS.includes(destination))
	)
		return null;
	return { destination, mode };
}

/**
 * Chrome's name for a request whose destination does not say what it is
 * (src/mixedContent.ts typeName): an XMLHttpRequest (the inject marks its
 * abort id), an EventSource (its Accept), a prefetch (its Sec-Purpose)
 */
function requestTypeOf(request: Request): string | undefined {
	if (request.headers.get(ABORT_HEADER)?.startsWith('xhr-'))
		return 'XMLHttpRequest endpoint';
	if (
		!request.destination &&
		(request.headers.get('accept') || '').includes('text/event-stream')
	)
		return 'EventSource endpoint';
	if (
		/prefetch/i.test(
			request.headers.get('sec-purpose') ??
				request.headers.get('purpose') ??
				'',
		)
	)
		return 'prefetch resource';
	return undefined;
}

/** how long a navigation with no referrer and no client waits for its document's NAVIGATION_HINT */
const NAVIGATION_HINT_WAIT_MS = 100;
const redirectHops = new Map<string, RedirectHop & { at: number }>();
const REDIRECT_HOP_TTL = 60_000;
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

function redirectKey(client: string, referrer: string, target: string): string {
	const url = new URL(target);
	url.hash = '';
	return `${client}\n${referrer}\n${url.href}`;
}

function rememberRedirect(
	client: string,
	referrer: string,
	location: string,
	base: string,
	hop: RedirectHop,
) {
	const now = Date.now();
	for (const [key, entry] of redirectHops)
		if (now - entry.at > REDIRECT_HOP_TTL) redirectHops.delete(key);
	try {
		redirectHops.set(
			redirectKey(client, referrer, new URL(location, base).href),
			{ ...hop, at: now },
		);
	} catch (error) {
		// a Location that is no URL: the browser will not follow it either
	}
}

/** the previous hop of this request's redirect chain, left where it is */
function peekRedirect(
	client: string,
	referrer: string,
	url: string,
): RedirectHop | undefined {
	const entry = redirectHops.get(redirectKey(client, referrer, url));
	return entry && Date.now() - entry.at <= REDIRECT_HOP_TTL ? entry : undefined;
}

/** whether this request is a later hop of a redirect chain the worker answered */
function redirectPending(client: string, referrer: string, url: string) {
	return !!peekRedirect(client, referrer, url);
}

/** what the previous hop of this request's redirect chain decided, if it was one */
function takeRedirect(
	client: string,
	referrer: string,
	url: string,
): RedirectHop | undefined {
	const key = redirectKey(client, referrer, url);
	const entry = redirectHops.get(key);
	if (!entry) return undefined;
	redirectHops.delete(key);
	return Date.now() - entry.at > REDIRECT_HOP_TTL ? undefined : entry;
}

/**
 * A frame's first navigation this worker answered with a document that
 * comes back at once (forward, "a frame's first navigation"): what the
 * navigation was, by the routed URL it comes back to. The request that comes
 * back is the browser's own, from that document: its referrer and policy
 * are that document's, and the navigation's are put back from here.
 */
const returns = new Map<
	string,
	{
		referrer: string;
		policy: ReferrerPolicy;
		url: string;
		/** a frame's fresh context asks for a redirect's target (src/freshFrame.ts) */
		fresh?: boolean;
		at: number;
	}
>();

function rememberReturn(
	to: string,
	navigation: {
		referrer: string;
		policy: ReferrerPolicy;
		url: string;
		fresh?: boolean;
	},
) {
	const now = Date.now();
	for (const [key, entry] of returns)
		if (now - entry.at > REDIRECT_HOP_TTL) returns.delete(key);
	returns.set(to, { ...navigation, at: now });
}

/**
 * A frame's navigation its document cancelled, made again in a fresh
 * browsing context (FRESH_RETURN): `referrer` (the document's routed URL)
 * is its referrer, under the policy the request has
 */
export function rememberFreshReturn(url: string, referrer: string) {
	rememberReturn(url, { referrer, policy: '', url, fresh: true });
}

function takeReturn(url: string) {
	const entry = returns.get(url);
	if (!entry) return undefined;
	returns.delete(url);
	return Date.now() - entry.at > REDIRECT_HOP_TTL ? undefined : entry;
}

const BODY_ILLEGAL = ['GET', 'HEAD'];

/**
 * Request headers that are not the page's own for the CORS protocol: the
 * proxy's markers and what the browser adds or forbids a page to set
 * (https://fetch.spec.whatwg.org/#forbidden-request-header)
 */
const FORBIDDEN_REQUEST_HEADERS = new Set([
	'accept-charset',
	'accept-encoding',
	'access-control-request-headers',
	'access-control-request-method',
	'connection',
	'content-length',
	'cookie',
	'cookie2',
	'date',
	'dnt',
	'expect',
	'host',
	'keep-alive',
	'origin',
	'referer',
	'set-cookie',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'upgrade-insecure-requests',
	'user-agent',
	'via',
]);
const notPagesHeader = (name: string) =>
	FORBIDDEN_REQUEST_HEADERS.has(name) ||
	name.startsWith('sec-') ||
	name.startsWith('proxy-') ||
	name.startsWith('x-stomp-');

/** whether a redirect's Location leaves the origin of the URL it answered */
function crossOriginLocation(location: string | null, from: StompURL): boolean {
	if (location === null) return false;
	try {
		return new URL(location, from.toString()).origin !== from.url.origin;
	} catch (error) {
		return false;
	}
}

type BodyTransform = (
	url: StompURL,
	response: Response,
	responseHeaders: Headers,
	referrer: ReferrerInfo,
	/** the request as it went upstream (its method, its final headers) */
	request: {
		method: string;
		headers: Headers;
		/** the routed URL the browser asked for, and its client (a navigation's: the document it makes) */
		routed: string;
		clientId?: string;
		navigation: boolean;
		/** the document's parent upgrades insecure requests (a nested document inherits it) */
		upgradeInsecure: boolean;
		/**
		 * what the rewrite cache keeps this request's output for: its network
		 * partition (as the HTTP cache's: the top-level site and the site of
		 * the frame or worker that asks) and whether it has credentials. Null
		 * when nothing may be kept for it: a client without a site of its own
		 * (as the HTTP cache)
		 */
		partition: string | null;
	},
	/** what the transform tells the request log */
	note: Note,
) => Promise<BodyInit | false>;

/** what a body's transform tells the request log (and the shell) */
interface Note {
	/** the emulated registration that controls the document (docs/service-workers.md) */
	serviceWorker?: ControlInfo;
	/** the document's isolation, when the host's page is isolated (src/isolation.ts isolationFacts) */
	isolation?: string;
	/** what the document's Origin-Agent-Cluster asked for: ?0 a cluster keyed by site, ?1 one keyed by origin */
	agentCluster?: 'site' | 'origin';
	rewriteCache?: RewriteCacheOutcome;
	rewriteIn?: 'pool' | 'pool split' | 'service-worker';
	/**
	 * a script the rewrite cache keeps as the response it was given
	 * (RewriteCache.matchServed): its routed URL, the key of its output, the
	 * partition it is kept for, and the kept response when there was one
	 * for that key
	 */
	served?: {
		url: string;
		key: string;
		partition: string;
		stored: Response | null;
	};
	rewriteBy?: 'wasm' | 'js';
}

interface Rewriter {
	codec: GenericCodec;
	directory: string;
	bare: BareCompatibleClient;
	config: Config;
	/** the host's error page, worker-only (never in the page's config) */
	errorPage?: string;
	/** the deployment's helper names (the error page global among them) */
	names?: Config['names'];
	cookies: Cookies;
	/** the HTTP cache, unless the host turned it off */
	cache?: HttpCache;
	/** the rewriter's output for scripts, unless the host turned the cache off */
	rewrites?: RewriteCache;
	/** the controller's rewrite workers, when it started any */
	pool?: RewritePool;
	/** the host's request log, when it asked for one */
	log?: (info: RequestInfo) => void;
	/** the host's request rules, compiled */
	rules: CompiledRule[];
	/** the built-in blocker, unless the host turned it off (docs/adblock.md) */
	blocker?: Blocker;
	/** the host asked for the blocker: the first navigation waits for its lists (on by default, none does) */
	blockerAsked?: boolean;
	/**
	 * the host page was reloaded (src/controller/hostReload.ts): the cache
	 * mode the pages it restores take, until when a navigation counts as
	 * one, and the documents a hard reload made (by client id, with when
	 * each stops loading past the caches)
	 */
	hostReload?: { mode: HostReload; until: number; loads: Map<string, number> };
	/** the host's page is cross-origin isolated (config.isolated) */
	isolated: boolean;
}

/** how long after a reloaded host's word a top-level navigation is one it restores */
const RESTORE_WINDOW_MS = 10_000;
/**
 * how long what a hard-reloaded document loads goes past the caches
 * (natively until its load event, which the worker does not hear of)
 */
const HARD_LOAD_MS = 30_000;

/** the page aborted the request (its signal fired) */
const ABORTED = Symbol('aborted');

/** the public suffix with the private list, as the jar and the partitions take it */
const publicSuffix = (host: string) => getPublicSuffix(host, true);

/**
 * What the shell of the document at `url` says of sites (src/siteFacts.ts):
 * this worker's answers for the document's own host, and for its top's
 * when it is served at a nested route (`routed`), whose site its storage is
 * keyed by. The inject then asks no list about either.
 */
function shellSites(
	url: StompURL,
	routed?: string,
	directory?: string,
): SiteFacts[] {
	const hosts = [url.url.hostname];
	if (routed !== undefined && directory !== undefined)
		try {
			const top = nestedTopOf(new URL(routed).pathname, directory);
			if (top) hosts.push(new URL(top).hostname);
		} catch (error) {
			// no top to name
		}
	const sites: SiteFacts[] = [];
	for (const host of new Set(hosts)) {
		const facts = siteFacts(host, { getDomain, getPublicSuffix });
		if (facts) sites.push(facts);
	}
	return sites;
}

/**
 * The top-level site a routed URL's kind names: a nested document's (its
 * top origin's site), a partitioned worker's; null for any other
 */
function routeTopSite(routed: string, directory: string): string | null {
	let pathname: string;
	try {
		pathname = new URL(routed).pathname;
	} catch (error) {
		return null;
	}
	const nested = nestedTopOf(pathname, directory);
	if (nested) return siteOf(nested, publicSuffix);
	if (!pathname.startsWith(directory)) return null;
	const kind = pathname.slice(directory.length).split('/')[0];
	// an emulated service worker's is its registration's
	if (kind.startsWith('sw:'))
		return partitionSite(serviceWorkers.versionPartition(kind.slice(3)));
	return partitionSite(workerKindPartition(kind));
}

/** the partition of a client of `origin` at a routed URL, from its route kind (src/partition.ts) */
function routePartition(
	routed: string,
	directory: string,
	origin: string,
): string {
	let pathname: string;
	try {
		pathname = new URL(routed).pathname;
	} catch (error) {
		return '';
	}
	if (!pathname.startsWith(directory)) return '';
	const kind = pathname.slice(directory.length).split('/')[0];
	if (kind.startsWith('sw:'))
		return serviceWorkers.versionPartition(kind.slice(3));
	return kindPartition(kind, origin, publicSuffix);
}

/** requests in flight the page may still abort, by the id it sent (ABORT_HEADER) */
const pendingAborts = new Map<string, () => void>();
/** the page posted that it aborted the request with this id */
export function abortRequest(id: unknown) {
	if (typeof id === 'string') pendingAborts.get(id)?.();
}

function genericForward(
	rewriter: Rewriter,
	transformBody: BodyTransform | void,
	transformRoute: RouteTransform,
	additionalRequestFilter: AdditionalFilter | void,
	additionalResponseFilter: AdditionalFilter | void,
) {
	const forward = async function (
		serverRequest: Request,
		_resolved?: string,
		context?: RouteContext,
	): Promise<Response> {
		const started = Date.now();
		// the page's abort reaches the worker as a message under the id the
		// page put in the request (Chrome does not fire the request's own
		// signal in a fetch event); the signal is honoured too where it fires
		const signal = (serverRequest as { signal?: AbortSignal }).signal;
		const abortId = serverRequest.headers.get(ABORT_HEADER);
		const abortedSoon = new Promise<never>((_, reject) => {
			if (abortId) pendingAborts.set(abortId, () => reject(ABORTED));
			if (!signal) return;
			if (signal.aborted) reject(ABORTED);
			else
				signal.addEventListener('abort', () => reject(ABORTED), { once: true });
		});
		abortedSoon.catch(() => {});
		const reportAborted = () =>
			rewriter.log?.({
				url: reportURL(url),
				method: serverRequest.method,
				destination: serverRequest.destination || 'fetch',
				status: 0,
				ms: Date.now() - started,
				cached: false,
				bytes: null,
				error: 'aborted',
				client: context?.clientId,
			});
		const oURL = new URL(serverRequest.url);
		const { url, resource } = parseRoutedURL(
			serverRequest.url,
			rewriter.codec,
			`${oURL.origin}${rewriter.directory}`,
		);

		// the same document asking again for an output it was just given
		const recentKey = transformBody
			? recentOutputKey(serverRequest, context)
			: null;
		// never a hop of a redirect chain: its origin may be "null" by then
		const recent =
			recentKey !== null &&
			!redirectPending(
				context?.clientId ?? '',
				serverRequest.referrer,
				serverRequest.url,
			)
				? takeRecentOutput(recentKey)
				: null;
		// what it was given was the rewrite cache's entry for its URL: that
		// entry again (the response Chrome keeps the compiled code with), if
		// it is still there
		const recentServed = recent?.served
			? ((await rewriter.rewrites?.matchServed(
					recent.served.url,
					recent.served.key,
				)) ?? null)
			: null;
		if (recent && (!recent.served || recentServed)) {
			rewriter.log?.({
				url: reportURL(url),
				method: serverRequest.method,
				destination: serverRequest.destination || 'fetch',
				status: recent.status,
				ms: Date.now() - started,
				cached: true,
				bytes: recent.bytes,
				client: context?.clientId,
				...(recentServed ? { rewriteCache: 'hit' as const } : {}),
			});
			if (recentServed) {
				// the entry cannot say how this load was delivered: the inject
				// is told (keptLoads.ts)
				noteKeptLoad(serverRequest.url, 'memory', context?.clientId);
				return recentServed;
			}
			return new Response(recent.body, {
				status: recent.status,
				statusText: recent.statusText,
				headers: recent.headers,
			});
		}

		// a route of a route (a page handed a hook its raw proxy URL, routed
		// again): the real URL is the inner route's, so the request is sent to
		// the single route of it, a document and a subresource alike
		const unwrapped =
			url.url.origin === oURL.origin
				? unwrapRoute(url.url, rewriter.codec)
				: null;
		if (unwrapped) {
			const single = `${oURL.origin}${rewriter.directory}${resource}/${new StompURL(
				unwrapped,
				url,
			).encode()}`;
			return new Response(null, {
				status: 307,
				headers: { location: single, 'cache-control': 'no-store' },
			});
		}

		// a route that decodes to the proxy's own origin would make the proxy
		// fetch itself (its host page, its worker): a loop and an exposure
		// of the host, so it is refused, like a blocked request
		if (url.url.origin === oURL.origin) {
			const page = DOCUMENT_DESTINATIONS.has(serverRequest.destination)
				? await hostErrorPage(rewriter, {
						url: reportURL(url),
						status: 403,
						error: 'refused: the proxy does not proxy its own origin',
						kind: 'refused',
					})
				: null;
			rewriter.log?.({
				url: reportURL(url),
				method: serverRequest.method,
				destination: serverRequest.destination || 'fetch',
				status: 403,
				ms: Date.now() - started,
				cached: false,
				bytes: 0,
				error: 'refused: the proxy does not proxy its own origin',
				kind: 'refused',
				// the host's page never reports a client id: no attribution to wait for
				...(page ? {} : { client: context?.clientId }),
			});
			return (
				page ??
				new Response('Stomp does not proxy its own origin', {
					status: 403,
					headers: { 'content-type': 'text/plain; charset=utf-8' },
				})
			);
		}

		const requestHeaders = filterNativeRequestHeaders(
			serverRequest.headers,
			url,
			additionalRequestFilter,
		);
		// ours, never the origin's (nor a cache key's)
		requestHeaders.delete(ABORT_HEADER);
		// a load the inject fetched for the page says so by the token of a
		// grant its client announced for this very request (loadGrants.ts),
		// or it is a later hop of a chain whose first hop did (the browser
		// repeats the header). Anything else in the header changes nothing:
		// the request is the page's own, judged by its real mode
		// (a request the worker makes itself is internal too: an emulated
		// service worker's script or the scripts it imports, no-cors loads
		// natively)
		const loadToken = serverRequest.headers.get(LOAD_HEADER);
		requestHeaders.delete(LOAD_HEADER);
		const earlierGrant =
			loadToken === null || serverRequest.mode === 'navigate'
				? undefined
				: peekRedirect(
						context?.clientId ?? '',
						serverRequest.referrer,
						serverRequest.url,
					)?.grant;
		const granted =
			serverRequest.mode === 'navigate'
				? null
				: earlierGrant
					? earlierGrant.token === loadToken
						? earlierGrant.load
						: null
					: await takeLoadGrant(
							loadToken,
							context?.clientId,
							serverRequest.url,
						);
		let internal = granted !== null || (!!context?.internal && !context.cors);
		const load = loadOf(granted);
		// a page's own request from an opaque origin (a document the page
		// sandboxed without allow-same-origin): never a navigation
		const opaque =
			serverRequest.mode !== 'navigate' &&
			serverRequest.headers.has(OPAQUE_HEADER);
		requestHeaders.delete(OPAQUE_HEADER);
		// an XMLHttpRequest with upload listeners (the CORS-preflight flag)
		const forcePreflight = serverRequest.headers.has(PREFLIGHT_HEADER);
		requestHeaders.delete(PREFLIGHT_HEADER);
		// an XMLHttpRequest's credentials, for a Basic challenge (httpAuth)
		const urlCredentials = serverRequest.headers.get(CREDENTIALS_HEADER);
		requestHeaders.delete(CREDENTIALS_HEADER);

		requestHeaders.set('user-agent', navigator.userAgent);
		// the browser's network stack adds it after this worker, so no request
		// here carries it: from the user's languages, as Chrome writes it
		if (!requestHeaders.has('accept-language')) {
			const languages = acceptLanguage(navigator.languages);
			if (languages) requestHeaders.set('accept-language', languages);
		}

		// Referer, Origin and the fetch metadata are forbidden headers, so the
		// service worker never sees the page's; rebuild them from the initiator
		// the way the browser would for the real origins, under the request's
		// own referrer policy (request.referrerPolicy: the browser derived it
		// from the document's Referrer-Policy header, its meta tag, the
		// element's attribute or fetch's init). The browser's own Referer is a
		// source of truth for the initiator only, never for the reduction: in
		// proxy URL space every proxied request looks same-origin to it, and
		// the worker's own fetch would be described, not the page's.
		requestHeaders.delete('referer');
		requestHeaders.delete('origin');
		// the browser adds its own fetch metadata after the worker, for the
		// proxy URL; the fetch event carries none (nor the page's user
		// activation)
		for (const name of FETCH_METADATA) requestHeaders.delete(name);
		// a ping names the page that sent it and the link's target, both
		// routes here: the site is told the real URLs, or nothing
		for (const name of ['ping-from', 'ping-to']) {
			const value = requestHeaders.get(name);
			if (value === null) continue;
			try {
				// (Ping-To is the link's href: a link route, src/visited.ts)
				const scope = `${oURL.origin}${rewriter.config.scope}`;
				const link = isLinkRoute(value, scope)
					? linkRouteURL(
							value.slice(scope.length + LINK_SEGMENT.length + 1),
							rewriter.codec,
						)
					: null;
				requestHeaders.set(
					name,
					(
						link ??
						parseRoutedURL(
							value,
							rewriter.codec,
							`${oURL.origin}${rewriter.directory}`,
						).url
					).toString(),
				);
			} catch (error) {
				requestHeaders.delete(name);
			}
		}
		const destination =
			load?.destination ?? (serverRequest.destination || 'empty');
		const navigation = serverRequest.mode === 'navigate';
		const nestedRoute = nestedTopOf(oURL.pathname, rewriter.directory);
		// every proxied page arrives here as an iframe (the host's frame): a
		// document the page did not route as nested (an iframe of its own, or
		// a navigation from inside one) is a top-level one
		const topLevel =
			destination === 'document' ||
			(destination === 'iframe' && nestedRoute === null);
		// a navigation that comes back from the document this worker answered
		// its first request with (below) is that first one again
		const returned = navigation ? takeReturn(serverRequest.url) : undefined;
		const policy =
			returned?.policy ||
			serverRequest.referrerPolicy ||
			DEFAULT_REFERRER_POLICY;
		const requestReferrer = returned
			? returned.referrer
			: serverRequest.referrer;

		// A frame's first navigation in a cross-origin isolated document, to a
		// document that will not be isolated there (the embedder's permission
		// does not reach its origin). Natively the frame's initial about:blank
		// is of the embedder's origin and the new document of another, which
		// gets a window of its own. Here both are of the proxy's origin, and
		// Chrome keeps the initial document's window for a navigation that
		// began as the frame was inserted, and with it the embedder's 5
		// microsecond clock, whatever the new document's policy says
		// (measured). So the first request is answered with a document that
		// replaces itself with the same URL, marked as no first navigation:
		// the frame leaves its initial state, the real document gets a new
		// window, and the frame fires no load event and gains no history
		// entry for it (measured). Nothing has gone to the site yet.
		if (
			rewriter.isolated &&
			navigation &&
			!topLevel &&
			(!returned || returned.fresh) &&
			serverRequest.method === 'GET'
		) {
			const kind = oURL.pathname.slice(rewriter.directory.length).split('/')[0];
			const mark = nestedMarkOfKind(kind);
			const parsed = mark === null ? null : parseNestedMark(mark);
			if (
				parsed &&
				parsed.embedder.group &&
				!parsed.embedder.later &&
				(parsed.embedder.delegates !== 'none' ||
					parsed.embedder.origins.length > 0) &&
				!delegatedTo(parsed.embedder, url.url.origin)
			) {
				const back = new URL(oURL);
				back.pathname = `${rewriter.directory}${kind.slice(
					0,
					kind.indexOf(':nested:') + ':nested:'.length,
				)}${encodeURIComponent(
					nestedMark(parsed.top, parsed.crossAncestor, {
						...parsed.embedder,
						later: true,
					}),
				)}${oURL.pathname.slice(rewriter.directory.length + kind.length)}`;
				rememberReturn(back.href, {
					referrer: requestReferrer,
					policy,
					url: returned?.url ?? serverRequest.url,
				});
				const headers = new Headers({
					'content-type': 'text/html; charset=utf-8',
					'cache-control': 'no-store',
				});
				isolationResponseHeaders(headers, { isolated: false, topLevel: false });
				return new Response(
					`<!doctype html><script>location.replace(${JSON.stringify(
						back.href,
					).replace(/</g, '\\u003c')} + location.hash)</script>`,
					{ headers },
				);
			}
		}

		const routedPrefix = `${oURL.origin}${rewriter.directory}`;
		const decode = (routed: string): URL | null => {
			try {
				return parseRoutedURL(routed, rewriter.codec, routedPrefix).url.url;
			} catch (error) {
				// not a routed URL: the proxy origin alone, the controller page,
				// a blob: worker, about:blank
				return null;
			}
		};
		const referrer =
			requestReferrer && requestReferrer !== 'about:client'
				? requestReferrer
				: null;

		// the request's client, by its real URL. Never for a navigation: its
		// client id is the document being created, and asking for it would
		// wait on this very response
		let client: URL | null = null;
		// its routed URL, when it is a routed document or worker
		let clientRoute: string | null = null;
		// a blob: worker whose minting page this worker does not know (it
		// restarted since, which empties what it was told, or the blob was
		// minted inside a worker): judged as another site, never as the
		// target's own, so it gets no same-origin credentials or Strict cookies
		let unknownBlob = false;
		// a client whose URL names no origin this worker can read (an
		// about:srcdoc document): judged by its Referer, else as an opaque one
		let unknownClient = false;
		// the top-level site of a partitioned blob: worker or inline document,
		// which its URL does not name (its creator's, as the worker recorded it)
		let clientTopSite: string | null = null;
		if (!navigation && context?.clientId && typeof clients !== 'undefined') {
			const id = context.clientId;
			client = clientURLs.get(id) ?? null;
			clientRoute = clientRoutes.get(id) ?? null;
			clientTopSite = clientTopSites.get(id) ?? null;
			if (!client)
				try {
					const found = await clients.get(id);
					// a blob: worker's URL is the blob: URL, an inline document's
					// its route: judged as the document that minted it, or as the
					// document served there, when the worker knows it
					const decoded = found ? decode(found.url) : null;
					if (decoded && found) clientRoute = found.url;
					client = found
						? ((found.url.startsWith('blob:') ||
							found.url.startsWith(`${routedPrefix}inline:`)
								? await knownOriginOf(found.url)
								: null) ?? decoded)
						: null;
					// an about:srcdoc document a routed ancestor vouched for is of
					// that ancestor's origin and partition (srcdocVouches); waited
					// for only when no Referer says whose the request is (Chrome
					// reports the client's URL as empty until it has parsed)
					if (
						!client &&
						found &&
						found.type === 'window' &&
						(found.url === '' || found.url.startsWith('about:srcdoc'))
					) {
						const bound = await boundClient(id, !referrer);
						if (bound) {
							client = bound.client;
							clientTopSite = bound.top;
						}
					}
					unknownBlob = !client && !!found?.url.startsWith('blob:');
					unknownClient = !client && !!found && !unknownBlob;
					if (
						client &&
						(found?.url.startsWith('blob:') ||
							found?.url.startsWith(`${routedPrefix}inline:`))
					)
						clientTopSite = await knownTopSiteOf(found.url);
				} catch (error) {
					// the client is gone
				}
			if (client && !clientURLs.has(id)) {
				if (clientURLs.size >= CLIENT_URLS_KEPT) {
					const oldest = clientURLs.keys().next().value!;
					clientURLs.delete(oldest);
					clientRoutes.delete(oldest);
					clientTopSites.delete(oldest);
				}
				clientURLs.set(id, client);
				if (clientRoute) clientRoutes.set(id, clientRoute);
				if (clientTopSite) clientTopSites.set(id, clientTopSite);
			}
		}

		// the Referer's source: the browser's routed Referer decoded, when it
		// kept the full URL; when the policy made it send the proxy origin
		// only (origin, strict-origin) the client stands in, since only its
		// origin is sent then
		let refererSource = referrer ? decode(referrer) : null;
		if (!refererSource && referrer === `${oURL.origin}/`)
			refererSource = client;

		// mixed content (src/mixedContent.ts), decided by the real URL of the
		// document that makes the request (for a nested navigation, the
		// parent at its referrer) and the proxied top's, under the document's
		// upgrade-insecure-requests. The browser sees https (or loopback)
		// proxy URLs only and never decides it. A top-level navigation (the
		// host's frame) is never mixed content
		let upgradeInsecure = false;
		let asked: URL | null = null;
		let mediaUpgraded = false;
		if (!(navigation && topLevel)) {
			const contextRoute = navigation ? referrer : (clientRoute ?? referrer);
			let top: string | null = navigation ? nestedRoute : null;
			if (!navigation && contextRoute)
				try {
					top = nestedTopOf(new URL(contextRoute).pathname, rewriter.directory);
				} catch (error) {
					// not a URL: no top to name
				}
			upgradeInsecure = upgradesInsecure(
				navigation ? undefined : context?.clientId,
				navigation ? null : clientRoute,
				referrer,
			);
			// the URL as the page asked for it (a stylesheet's url() keeps its
			// own in a fragment the rewriter adds)
			asked = new URL(reportURL(url));
			const verdict = mixedContentVerdict({
				url: asked,
				destination,
				imageSet: resource === 'binary:set',
				type: requestTypeOf(serverRequest),
				context: navigation ? refererSource : (client ?? refererSource),
				top,
				upgradeInsecure,
			});
			postNotices(
				verdict.notices,
				navigation ? undefined : context?.clientId,
				navigation ? referrer : null,
			);
			if (verdict.action === 'block') {
				rewriter.log?.({
					url: reportURL(url),
					method: serverRequest.method,
					destination: serverRequest.destination || 'fetch',
					status: 0,
					ms: Date.now() - started,
					cached: false,
					bytes: null,
					error: 'blocked: mixed content',
					kind: 'blocked',
					client: context?.clientId,
				});
				// a blocked frame navigation is cancelled (no document commits,
				// the frame keeps the one it has), and an EventSource fails for
				// good (a network error would make it reconnect); anything else
				// is a network error
				return navigation ||
					requestTypeOf(serverRequest) === 'EventSource endpoint'
					? new Response(null, { status: 204 })
					: Response.error();
			}
			if (verdict.action === 'upgrade') {
				// a navigation goes to its https route, so the document it makes
				// is https; a subresource is fetched over https in its place, as
				// the browser upgrades it before it goes out
				if (navigation)
					return new Response(null, {
						status: 307,
						headers: {
							location: `${oURL.origin}${rewriter.directory}${resource}/${new StompURL(
								verdict.url,
								url,
							).encode()}`,
							'cache-control': 'no-store',
						},
					});
				url.url = verdict.url;
				mediaUpgraded = !!verdict.media;
			}
		}

		// a redirect this worker answered earlier in the same chain decided
		// the referrer already: the next hop starts from that (stripped) value
		const hopClient = navigation ? '' : (context?.clientId ?? '');
		const previousHop = takeRedirect(
			hopClient,
			requestReferrer,
			returned?.url ?? serverRequest.url,
		);
		const carried = previousHop?.referer;
		const referer =
			carried !== undefined
				? carried && refererFor(new URL(carried), url.url, policy)
				: refererSource && refererFor(refererSource, url.url, policy);
		if (referer) requestHeaders.set('referer', referer);
		// what the document this request creates shows as document.referrer;
		// when the browser sent only the proxy origin for a navigation the
		// initiator is unknown here, and the inject applies the policy to the
		// parent document it can see
		const referrerInfo: ReferrerInfo =
			carried !== undefined || refererSource
				? { referrer: referer ?? '' }
				: referrer === `${oURL.origin}/`
					? { policy }
					: { referrer: '' };

		// the request's origin: its client's; a navigation has none to ask, so
		// the document that started it (its Referer), or for a nested document
		// whose referrer was withheld the top-level page that routed it
		const known =
			client ??
			refererSource ??
			(navigation && nestedRoute ? new URL(nestedRoute) : null);
		// a navigation's document told the worker it started it (its message
		// may trail the request a little); it names the initiator only for a
		// navigation that came with no referrer at all and no earlier hop,
		// which would otherwise pass for the user's own from the host, and
		// only that wait is ever paid (the host's frame.go sends the host page
		// as its referrer)
		let hint: NavigationHint | null = null;
		if (navigation) {
			hint = takeNavigationHint(url.url.href);
			if (!hint && !known && !referrer && !previousHop)
				hint = await awaitNavigationHint(
					url.url.href,
					rewriter.config.navigationHintWait ?? NAVIGATION_HINT_WAIT_MS,
				);
		}
		const hinted =
			hint && !referrer && !previousHop ? new URL(hint.origin) : null;
		const initiator =
			known ??
			hinted ??
			(previousHop?.initiator ? new URL(previousHop.initiator) : null);
		// the page had user activation when this navigation (or the chain it
		// redirects) began
		const activated = !!(hint?.activated || previousHop?.user);
		// an opaque origin is the same origin as nothing: its Origin is "null"
		const sameOrigin =
			!opaque &&
			!unknownBlob &&
			initiator !== null &&
			initiator.origin === url.url.origin;
		// a download the inject saves for a page starts at the page's own
		// origin (the `download` attribute counts for nothing else): a grant
		// that names one for another origin's URL is not one
		if (granted === 'download' && !previousHop && !sameOrigin)
			internal = !!context?.internal && !context.cors;

		// the browser sends Origin on cross-origin CORS requests and on every
		// request with a body; Chrome also on a module script's, same-origin
		// or not
		if (
			(initiator || opaque) &&
			((!sameOrigin && serverRequest.mode === 'cors') ||
				(serverRequest.mode === 'cors' && destination === 'script') ||
				!BODY_ILLEGAL.includes(serverRequest.method))
		)
			requestHeaders.set('origin', opaque ? 'null' : initiator!.origin);

		// Sec-Fetch-Site: `none` for a navigation nobody in a page started (the
		// host's, which the user typed or picked); a subresource whose client
		// is not a proxied page is taken as its target's own, the benefit the
		// credentials mode gives it too, except a blob: worker of a page this
		// worker does not know (unknownBlob), which is another site
		let site: Site =
			unknownBlob || opaque
				? 'cross-site'
				: initiator
					? siteBetween(initiator, url.url)
					: navigation
						? 'none'
						: 'same-origin';

		// the jar applies SameSite against the request's site; a nested
		// document's requests are judged by the top-level page as well (the
		// browser's site for cookies walks the ancestors, Sec-Fetch-Site does
		// not): the route kind of the navigation, or of the referrer when a
		// nested document is the initiator, names that top origin. A
		// cross-site link into a site that keeps its login in Lax cookies
		// still works, a nested cross-site frame gets None only
		const nestedTop =
			nestedRoute ??
			(referrer
				? nestedTopOf(new URL(referrer).pathname, rewriter.directory)
				: null);
		const nestedSite = nestedTop
			? widestSite(site, siteBetween(new URL(nestedTop), url.url))
			: site;
		// the partition of the request's Partitioned cookies (CHIPS): its
		// top-level site, when that is not the target's own. A top-level
		// navigation's is its own; a nested one's top is in its route; a
		// subresource's in its client's route (a nested document's, a
		// partitioned worker's), else it is the client's own site (a
		// top-level document)
		const topSite = navigation
			? topLevel || !nestedRoute
				? null
				: siteOf(nestedRoute, publicSuffix)
			: (clientTopSite ??
				(clientRoute ? routeTopSite(clientRoute, rewriter.directory) : null) ??
				(nestedTop ? siteOf(nestedTop, publicSuffix) : null) ??
				(client && client.origin !== 'null'
					? siteOf(client, publicSuffix)
					: null));
		// A context in a partition (a site framed by another, or framed under
		// a frame of another site) keeps its Partitioned cookies under its top
		// site whatever it asks for; a first-party one only those of another
		// site, as Chrome's cookie partition key has the ancestor chain bit
		// (measured: B framed by A reads what B set for A's own request, and B
		// framed by A framed by B none of B's top-level page's)
		const contextPartition = navigation
			? topLevel
				? ''
				: kindPartition(resource, url.url.origin, publicSuffix)
			: clientTopSite
				? `^${clientTopSite}`
				: clientRoute && client
					? routePartition(clientRoute, rewriter.directory, client.origin)
					: '';
		const partitionKey =
			partitionSite(contextPartition) ??
			(topSite !== null && topSite !== siteOf(url.url, publicSuffix)
				? topSite
				: undefined);
		// A request with a partition key is one whose site for cookies is
		// another site: a context in a partition (whatever it asks for, since
		// its ancestors are not all of its top's site; A in B in A too, and a
		// partitioned worker, whose route names no nested top), or one asking
		// for another site than its top's. Chrome sends such a request its
		// SameSite=None cookies alone, as it does one another site started,
		// and keeps none but SameSite=None ones from the response of either
		// (measured: a frame of the top's site that another site's frame
		// navigated keeps only those); a top-level navigation sets any cookie.
		const cookieSite = partitionKey !== undefined ? 'cross-site' : nestedSite;
		const crossSiteSet =
			cookieSite === 'cross-site' && !(navigation && topLevel);

		// the chain's earlier hops count for the site (Sec-Fetch-Site only:
		// the browser's site for cookies does not follow redirects)
		// a later hop of a chain a page started arrives without a referrer, as
		// its first did: its site is the chain's
		if (previousHop)
			site =
				site === 'none' && !initiator
					? previousHop.site
					: widestSite(previousHop.site, site);

		if (potentiallyTrustworthy(url.url)) {
			requestHeaders.set('sec-fetch-site', site);
			requestHeaders.set(
				'sec-fetch-mode',
				load?.mode ??
					(serverRequest.mode ||
						(destination === 'empty' ? 'cors' : 'no-cors')),
			);
			requestHeaders.set(
				'sec-fetch-dest',
				navigation && topLevel ? 'document' : destination,
			);
			// only a navigation the user started: the host's (typed, picked),
			// or one a page started under user activation (its hint said so)
			if (navigation && ((topLevel && site === 'none') || activated))
				requestHeaders.set('sec-fetch-user', '?1');
		}

		// the request's credentials mode, as the browser would apply it to its
		// own jar: `omit` sends and stores no cookies, `same-origin` only when
		// the initiator's real origin is the target's (every proxied request
		// looks same-origin to the browser, so this is decided here; an
		// unknown initiator is given the benefit), `include` always
		// The embedder policy of the document or worker that makes the request
		// (src/isolation.ts), when the host's page is isolated: the browser
		// has the proxy's for every document there, so the page's own is
		// applied here. A `credentialless` one sends its no-cors requests to
		// another origin without credentials, and keeps none from the answer.
		const ownerPolicy =
			rewriter.isolated && !navigation
				? embedderPolicyOf(context?.clientId, clientRoute, referrer)
				: null;
		const credentialless =
			ownerPolicy?.policy === 'credentialless' &&
			initiator !== null &&
			!sameOrigin &&
			(load?.mode ?? (internal ? 'no-cors' : serverRequest.mode)) === 'no-cors';
		const credentials =
			serverRequest.credentials === 'omit' || credentialless
				? false
				: serverRequest.credentials === 'same-origin'
					? (initiator === null && !unknownBlob && !opaque) || sameOrigin
					: true;
		// no cookie to send is no Cookie header, as the browser sends it
		const cookie = credentials
			? (
					await rewriter.cookies.get(url.url, {
						site: cookieSite,
						navigation: topLevel,
						method: serverRequest.method,
						partitionKey,
					})
				).toString()
			: '';
		if (cookie) requestHeaders.set('cookie', cookie);
		else requestHeaders.delete('cookie');

		// client hints between the real origins (clientHints.ts): a
		// subresource by its document's accepted set and policy; a frame's
		// navigation by its main frame's, judged from its parent (at its
		// referrer) or the top it was routed under; a top-level navigation by
		// what its origin accepted
		const hintsTop = navigation
			? topLevel
				? url.url.origin
				: nestedRoute
			: null;
		const hintsDoc = navigation
			? topLevel
				? null
				: (hintsDocument(undefined, referrer) ??
					(nestedRoute ? topDocument(nestedRoute) : null))
			: hintsDocument(context?.clientId, clientRoute);
		const hintsContext: HintsContext = {
			target: url.url,
			secure: potentiallyTrustworthy(url.url),
			navigation,
			topLevel,
			doc: hintsDoc,
			top: hintsTop,
			directory: rewriter.directory,
			pageRequest: !navigation && serverRequest.destination === '' && !internal,
			...(navigation && !topLevel && hint?.allow !== undefined
				? { allow: hint.allow }
				: {}),
		};
		let sentHints = await applyClientHints(requestHeaders, hintsContext);

		// HTTP authentication as the browser's auth cache does it (httpAuth):
		// a request that may carry credentials and has no Authorization of the
		// page's own sends the one an earlier answer under this directory
		// kept, unless it brings credentials of its own, which wait for the
		// challenge
		const pageAuthorization = requestHeaders.has('authorization');
		const mayAuthenticate = credentials && !pageAuthorization;
		if (mayAuthenticate && !urlCredentials) {
			const ahead = authorizationAhead(url.url);
			if (ahead) requestHeaders.set('authorization', ahead);
		}

		// The same-origin policy between the real origins (cors.ts). The mode
		// is the request's own; an inject's copy of a page's load is that load
		// (its grant names it), and any other copy (a download, a load whose
		// kind the worker takes no metadata from) the browser's own no-cors
		// load of it.
		// The origin compared is the initiator's: "null" for an opaque one, a
		// blob: worker or client this worker cannot place, and after a
		// redirect from another origin to a third
		const policyMode = navigation
			? 'navigate'
			: (load?.mode ?? (internal ? 'no-cors' : serverRequest.mode));
		const policyOrigin =
			opaque || unknownBlob || previousHop?.tainted
				? 'null'
				: (initiator?.origin ??
					(unknownClient && !refererSource ? 'null' : null));
		const crossOrigin =
			!navigation &&
			policyOrigin !== null &&
			(policyOrigin === 'null' || policyOrigin !== url.url.origin);
		const corsChecked = crossOrigin && policyMode === 'cors';
		// a subresource the inject copies for a page under a grant: its bytes
		// go to the page's process as a blob (not a download, which the page
		// never holds, nor an object's or embed's document, a navigation)
		const copiedLoad =
			granted !== null &&
			internal &&
			granted !== 'download' &&
			load?.mode !== 'navigate';
		// the site of the frame or worker that makes the request (a
		// navigation's is its destination's), null for an opaque or unknown
		// one: with the top-level site, the network partition (the HTTP and
		// preflight caches)
		const requestFrameSite = navigation
			? siteOf(url.url, publicSuffix)
			: client && client.origin !== 'null' && !opaque
				? siteOf(client, publicSuffix)
				: null;
		// some hop of this request's chain, this one or an earlier, was of
		// another origin: a no-cors answer is opaque (A to B to A included)
		const chainCrossed = crossOrigin || !!previousHop?.crossed;
		const credentialsIncluded = serverRequest.credentials === 'include';
		if (previousHop?.tainted && requestHeaders.has('origin'))
			requestHeaders.set('origin', 'null');
		/** a request the browser would refuse: a network error to the page */
		const refuse = (error: string, method = serverRequest.method) => {
			rewriter.log?.({
				url: reportURL(url),
				method,
				destination: serverRequest.destination || 'fetch',
				status: 0,
				ms: Date.now() - started,
				cached: false,
				bytes: null,
				error,
				client: context?.clientId,
			});
			return Response.error();
		};
		if (crossOrigin && policyMode === 'same-origin')
			return refuse('blocked: a same-origin request to another origin');

		// the built-in blocker (docs/adblock.md), on the real request and the
		// real document that makes it (a navigation's: the page that frames
		// it), before the host's rules, the page's emulated service worker,
		// the cache and the transport: what the lists block reaches none of
		// them. A request the worker makes for itself is not the page's
		const blocker = context?.internal ? undefined : rewriter.blocker;
		// the first navigation after a start waits for the engine: the stored
		// one, and, when the host asked for the blocker, a first fetch of the
		// lists, bounded
		if (blocker && navigation && !blocker.ready)
			await blocker.settled(!!rewriter.blockerAsked);
		const decision = blocker?.decide({
			url: reportURL(url),
			source:
				(navigation
					? (refererSource ?? (nestedRoute ? new URL(nestedRoute) : null))
					: (client ?? refererSource)
				)?.href ?? '',
			destination,
			navigation,
			topLevel,
			method: serverRequest.method,
			ping:
				serverRequest.headers.has('ping-to') ||
				(!serverRequest.destination &&
					serverRequest.keepalive &&
					serverRequest.mode === 'no-cors' &&
					serverRequest.method === 'POST'),
		});
		if (decision?.block) {
			// as a content blocker's ERR_BLOCKED_BY_CLIENT reaches a page: a
			// network error, nothing of the proxy's in it. A top-level
			// document is the user's own navigation: the host's page says why
			const page =
				navigation && topLevel
					? await hostErrorPage(rewriter, {
							url: reportURL(url),
							status: 403,
							error: 'blocked by the content blocker',
							kind: 'blocked',
						})
					: null;
			rewriter.log?.({
				url: reportURL(url),
				method: serverRequest.method,
				destination: serverRequest.destination || 'fetch',
				status: 0,
				ms: Date.now() - started,
				cached: false,
				bytes: null,
				error: 'blocked by the content blocker',
				kind: 'blocked',
				...(page ? {} : { client: context?.clientId }),
			});
			return page ?? Response.error();
		}
		if (decision?.resource) {
			// `$redirect`: the lists' stand-in for the resource (an empty
			// script, a 1x1 image), answered here and rewritten like the
			// origin's own answer would be
			const stand = new Response(decision.resource.body, {
				headers: { 'content-type': decision.resource.type },
			});
			const standHeaders = new Headers({
				'content-type': decision.resource.type,
				'cache-control': 'no-store',
			});
			const output = transformBody
				? await transformBody(
						url,
						stand,
						standHeaders,
						referrerInfo,
						{
							method: serverRequest.method,
							headers: requestHeaders,
							routed: serverRequest.url,
							clientId: context?.clientId,
							navigation,
							upgradeInsecure,
							// the lists' resource, not the origin's: never kept
							partition: null,
						},
						{},
					)
				: false;
			rewriter.log?.({
				url: reportURL(url),
				method: serverRequest.method,
				destination: serverRequest.destination || 'fetch',
				status: 200,
				ms: Date.now() - started,
				cached: false,
				bytes: decision.resource.body.length,
				error: 'redirected by the content blocker',
				client: context?.clientId,
			});
			return new Response(output === false ? stand.body : output, {
				headers: standHeaders,
			});
		}
		if (decision?.url) {
			// `$removeparam`: the request goes out without the parameters; a
			// navigation is redirected, so the document's URL is the one fetched
			const stripped = new URL(decision.url);
			if (navigation)
				return new Response(null, {
					status: 307,
					headers: {
						location: `${oURL.origin}${rewriter.directory}${resource}/${new StompURL(
							stripped,
							url,
						).encode()}`,
						'cache-control': 'no-store',
					},
				});
			url.url = stripped;
		}

		// the host's rules, on the real request as it would go out: the first
		// match blocks, answers, redirects or edits headers. Before the cache
		// (a blocked or redirected request never touches it) and logged as such
		// the rules see the request's real destination. A load the inject
		// copied for a page (a granted LOAD_HEADER) counts as the load it
		// names too, for a rule that blocks it; a rule that edits headers,
		// redirects or answers takes the real destination only, as it did
		// when the header was the page's to write
		const realDestination = serverRequest.destination || 'empty';
		const rule = rewriter.rules.find(
			(candidate) =>
				candidate.matches(
					url.url,
					serverRequest.method,
					realDestination,
					site,
				) ||
				(load !== null &&
					candidate.action === 'block' &&
					candidate.matches(
						url.url,
						serverRequest.method,
						load.destination,
						site,
					)),
		);
		if (rule) {
			const answer = (
				status: number,
				headers?: Record<string, string>,
				error?: string,
				kind?: RequestErrorKind,
				hostPage = false,
			) => {
				rewriter.log?.({
					url: reportURL(url),
					method: serverRequest.method,
					destination: serverRequest.destination || 'fetch',
					status,
					ms: Date.now() - started,
					cached: false,
					bytes: 0,
					...(error ? { error } : {}),
					...(kind ? { kind } : {}),
					// the host's page never reports a client id: no attribution to wait for
					...(hostPage ? {} : { client: context?.clientId }),
					rule: rule.index,
				});
				return new Response(null, { status, headers });
			};
			if (rule.action === 'block') {
				const page = DOCUMENT_DESTINATIONS.has(serverRequest.destination)
					? await hostErrorPage(rewriter, {
							url: reportURL(url),
							status: 403,
							error: 'blocked by a rule',
							kind: 'blocked',
						})
					: null;
				const built = answer(
					403,
					undefined,
					'blocked by a rule',
					'blocked',
					!!page,
				);
				return page ?? built;
			}
			if (rule.action.status !== undefined)
				return answer(rule.action.status, undefined, 'answered by a rule');
			if (rule.action.redirect !== undefined)
				return answer(
					307,
					{
						location: routeHTML(
							new StompURL(new URL(rule.action.redirect, url.toString()), url),
							url,
							rewriter.config,
							false,
							nestedMarkOf(oURL.pathname, rewriter.directory) ?? false,
						),
					},
					'redirected by a rule',
				);
			applyHeaderRule(requestHeaders, rule.action.requestHeaders);
		}
		// the origin the CORS protocol speaks for: the initiator's, unless a
		// host's rule sent the site another Origin (the host's own, for a site
		// that only answers it): the site's answer names that one, and the
		// host vouched for it
		const ruled =
			rule && rule.action !== 'block' && rule.action.requestHeaders
				? requestHeaders.get('origin')
				: null;
		const corsOrigin = ruled ?? policyOrigin;

		// the body goes out whole, as a Blob (the browser keeps a large one
		// out of the worker's memory): a fetch event's body is always a
		// stream, whatever the page gave, and epoxy sends a stream as a chunked
		// upload, which servers that need a Content-Length refuse (IIS answers
		// 411 Length Required: every Bing API call failed). Natively, only a
		// page's own ReadableStream goes out without a length
		const upload =
			BODY_ILLEGAL.includes(serverRequest.method) || !serverRequest.body
				? Promise.resolve(undefined)
				: serverRequest.blob();
		upload.catch(() => {});

		// the fields go out in the order Chrome sends them (headerOrder.ts)
		const shape: RequestShape = {
			navigation: navigation && DOCUMENT_DESTINATIONS.has(destination),
			destination: navigation && topLevel ? 'document' : destination,
			mode:
				load?.mode ??
				(serverRequest.mode || (destination === 'empty' ? 'cors' : 'no-cors')),
			method: serverRequest.method,
			cache: serverRequest.cache,
		};
		const fetchUpstream = (headers: Headers) => {
			const upstream = upload.then((body) =>
				rewriter.bare.fetch(url.toString(), {
					method: serverRequest.method,
					redirect: 'manual',
					// redirect: serverRequest.redirect,
					body,
					headers: chromeOrderedHeaders(headers, shape),
				}),
			);
			// an answer that arrives after the page gave up is dropped unread, so
			// the transport stops reading it
			upstream.then(
				(response) => {
					if (signal?.aborted) response.body?.cancel().catch(() => {});
				},
				() => {},
			);
			return Promise.race([upstream, abortedSoon]);
		};
		// a navigation preload request (navigation preload on): the
		// navigation's own, with the registration's header, sent while the
		// emulated worker starts; its cookies are set as it arrives, as the
		// browser's network stack does, whoever reads it
		const startPreload = async (value: string) => {
			const headers = new Headers(requestHeaders);
			headers.set('service-worker-navigation-preload', value);
			const preloaded = await fetchUpstream(headers);
			const rest: [string, string][] = [];
			for (const [header, field] of preloaded.rawHeaders ?? [])
				if (header.toLowerCase() !== 'set-cookie') rest.push([header, field]);
				else if (credentials)
					await rewriter.cookies.set(
						field,
						url.url,
						'http',
						partitionKey,
						crossSiteSet,
					);
			preloaded.rawHeaders = rest;
			return preloaded;
		};
		// the page's emulated service worker answers before the HTTP cache and
		// the network, as a real one sits before them (docs/service-workers.md)
		const {
			response: fromWorker,
			control,
			network: preloaded,
		} = await answerFromServiceWorker(
			rewriter,
			serverRequest,
			url,
			context,
			upload,
			referer ?? '',
			navigation && topLevel ? 'document' : serverRequest.destination,
			startPreload,
		);
		// the worker gave the page a network error
		if (fromWorker?.type === 'error') return Response.error();

		// a cross-origin request the CORS protocol does not let go out as it
		// is asks first (when it reaches the network: a request the page's
		// emulated service worker answers is that worker's to make): an OPTIONS with the method and the page's headers
		// that are not safelisted, without credentials; its answer must allow
		// both, and is kept for its max-age
		if (corsChecked && !fromWorker) {
			const unsafe = unsafeHeaderNames(serverRequest.headers, notPagesHeader);
			// kept per network partition, as Chrome keeps its preflight cache
			const preflightPartition = `${topSite ?? ''} ${requestFrameSite ?? ''}`;
			if (
				(forcePreflight || needsPreflight(serverRequest.method, unsafe)) &&
				!preflightCached(
					corsOrigin!,
					url.toString(),
					credentialsIncluded,
					serverRequest.method,
					unsafe,
					preflightPartition,
				)
			) {
				const preflightHeaders = new Headers({
					accept: '*/*',
					'access-control-request-method': serverRequest.method,
					origin: corsOrigin!,
					'user-agent': requestHeaders.get('user-agent') ?? '',
				});
				if (unsafe.length)
					preflightHeaders.set(
						'access-control-request-headers',
						unsafe.join(','),
					);
				for (const name of ['accept-language', 'referer'])
					if (requestHeaders.has(name))
						preflightHeaders.set(name, requestHeaders.get(name)!);
				if (potentiallyTrustworthy(url.url)) {
					preflightHeaders.set('sec-fetch-mode', 'cors');
					preflightHeaders.set('sec-fetch-site', site);
					preflightHeaders.set('sec-fetch-dest', destination);
				}
				let allowed = false;
				try {
					const answer = await Promise.race([
						rewriter.bare.fetch(url.toString(), {
							method: 'OPTIONS',
							redirect: 'manual',
							headers: chromeOrderedHeaders(preflightHeaders, {
								navigation: false,
								destination,
								mode: 'cors',
								method: 'OPTIONS',
								cache: 'no-store',
							}),
						}),
						abortedSoon,
					]);
					await answer.body?.cancel().catch(() => {});
					allowed = preflightAllows(
						answer,
						corsOrigin!,
						url.toString(),
						credentialsIncluded,
						serverRequest.method,
						unsafe,
						preflightPartition,
					);
				} catch (error) {
					if (error === ABORTED) {
						reportAborted();
						return Response.error();
					}
				}
				if (!allowed)
					return refuse(
						'blocked by CORS policy: the preflight failed',
						'OPTIONS',
					);
			}
		}

		// the HTTP cache, unless the host turned it off, keeping and asking as
		// Chrome's does (docs/http-cache.md): a fresh entry answers without
		// the transport; one that is stale, `no-cache`, or made for another
		// request (its Vary, its credentials) is confirmed by the origin with
		// the validators it gave, and a 304 refreshes it; what comes back
		// cacheable is stored (its body split in two, one copy for the
		// store). Stale entries are used only as far as the origin allowed:
		// within stale-while-revalidate they answer at once and one
		// revalidation runs behind the page. A 206 is kept as a part of the
		// resource, and completed by range (completePart).
		// Kept per network partition (cache.ts partitionedKey): the top-level
		// site and the site of the frame or worker that asks (a navigation's
		// is its destination's); a request whose client has no site of its
		// own (opaque, unknown) is not cached at all.
		const frameSite = requestFrameSite;
		const cacheKey =
			frameSite === null
				? null
				: partitionedKey(url.toString(), topSite ?? frameSite, frameSite);
		const cache = cacheKey === null ? undefined : rewriter.cache;
		// The renderer's memory cache (cache.ts MemoryCache), asked first for
		// what a renderer keeps there: what this site's documents loaded is
		// theirs, per site of the document that asks. The browser is handed
		// these as no-cache without validators (below), so it comes back here
		// for each document and never revalidates another site's copy: the
		// conditional headers it adds are dropped (a page cannot set them on
		// these loads).
		const memoryDestination =
			!navigation && MEMORY_DESTINATIONS.has(destination);
		if (memoryDestination) {
			requestHeaders.delete('if-none-match');
			requestHeaders.delete('if-modified-since');
		}
		// The request's cache mode, as Chrome's HTTP cache takes it
		// (docs/http-cache.md). What the page wrote in the request's headers
		// changes the default: with a conditional header of its own the
		// request is the page's business (the cache neither answers nor keeps
		// the answer, and the origin is asked with max-age=0), its own
		// `Cache-Control: no-cache` or `Pragma: no-cache` is a reload, its
		// `max-age=0` a revalidation.
		// (Chrome hands the worker a request with a conditional header as
		// `no-cache` already)
		let cacheMode: RequestCache = serverRequest.cache;
		if (OWN_CONDITIONALS.some((name) => requestHeaders.has(name))) {
			if (cacheMode === 'default' || cacheMode === 'no-cache') {
				cacheMode = 'no-store';
				shape.cache = 'no-cache';
			}
		} else if (cacheMode === 'default') {
			const asked = parseCacheControl(requestHeaders.get('cache-control'));
			if (
				asked.has('no-cache') ||
				/(^|,)\s*no-cache\s*(,|$)/i.test(requestHeaders.get('pragma') || '')
			)
				cacheMode = 'reload';
			else if (asked.get('max-age') === '0') cacheMode = 'no-cache';
		}
		// A host page that was reloaded shows its page again with a new
		// navigation, which takes the reload's mode: `no-cache` for the
		// document after a reload, `reload` for the document and what it
		// loads after a hard one, as natively.
		const restored = rewriter.hostReload;
		if (restored && cacheMode === 'default') {
			const now = Date.now();
			if (navigation && topLevel && now < restored.until) {
				cacheMode = shape.cache = restored.mode;
				if (restored.mode === 'reload' && context?.clientId)
					restored.loads.set(context.clientId, now + HARD_LOAD_MS);
			} else if (
				!navigation &&
				context?.clientId &&
				(restored.loads.get(context.clientId) ?? 0) > now
			)
				cacheMode = shape.cache = 'reload';
		}
		// `force-cache` and `only-if-cached` take an entry however stale; a
		// navigation that asks for the latter (history, to a form's result)
		// goes on to the network for what is not kept, since a POST's answer
		// never is
		const takesStale =
			cacheMode === 'force-cache' || cacheMode === 'only-if-cached';
		const memoryKey =
			memoryDestination &&
			frameSite !== null &&
			serverRequest.method === 'GET' &&
			!context?.bypassCache &&
			!['no-store', 'reload', 'no-cache'].includes(cacheMode)
				? MemoryCache.key(frameSite, credentials, url.toString())
				: null;
		const remembered =
			memoryKey !== null && !fromWorker && !preloaded
				? memoryCache.match(memoryKey, requestHeaders)
				: null;
		let hit =
			!remembered &&
			!fromWorker &&
			!preloaded &&
			cache &&
			!context?.bypassCache &&
			cacheMode !== 'no-store' &&
			cacheMode !== 'reload' &&
			(serverRequest.method === 'GET' || serverRequest.method === 'HEAD')
				? await cache.match(cacheKey!, requestHeaders)
				: null;
		let response: Response & { rawHeaders?: [string, string][] };
		let cached = false;
		// the origin confirmed the HTTP cache's entry with a 304
		let revalidated = false;
		// natively the renderer's memory cache answers, or revalidates what it
		// has, rather than the HTTP cache (messages.ts Delivery)
		let memory = false;
		// (an entry the origin has to confirm for this request, or a request
		// that asks for the confirmation, is not served stale on any terms)
		const within = (window: number | null) =>
			!!hit &&
			!hit.mustRevalidate &&
			!hit.revalidate &&
			cacheMode !== 'no-cache' &&
			window !== null &&
			hit.staleFor <= window;
		const withValidators = (headers: Headers) => {
			const conditional = new Headers(headers);
			if (hit?.etag) conditional.set('if-none-match', hit.etag);
			if (hit?.lastModified)
				conditional.set('if-modified-since', hit.lastModified);
			return conditional;
		};
		// Clear-Site-Data: "cache" from the origin itself (a secure one, as
		// natively): what the caches keep of that origin goes, in every
		// partition, and the answer that says so is not kept either. The
		// header's other types are not acted on, and it never reaches the
		// browser (filterHeaders).
		const clears = (responseHeaders: Headers) =>
			clearsCache(responseHeaders.get('clear-site-data')) &&
			potentiallyTrustworthy(url.url);
		const storable = (status: number, responseHeaders: Headers) =>
			!!cache &&
			cacheMode !== 'no-store' &&
			!clears(responseHeaders) &&
			isCacheable({
				method: serverRequest.method,
				requestHeaders,
				status,
				responseHeaders,
			});
		// what the origin answered on the way to completing a part, that
		// answers the request as it is (a 200: the resource changed, or the
		// origin sends it whole): the forward goes on with it
		let answered: Awaited<ReturnType<typeof fetchUpstream>> | null = null;
		// the part was dropped on the way: what the origin answers now is
		// not kept (completePart)
		let restarted = false;
		// The part of the resource an entry holds (cache.ts Part), as
		// Chrome's cache completes a sparse entry: the bytes the request asks
		// for that it holds come from it, confirmed with the origin by a
		// conditional request for those bytes unless it holds them all and
		// is fresh, and the bytes it lacks are asked for by range. What does
		// not fit together that way (another version, an answer that is not
		// the bytes asked for) is fetched as the page asked, no condition.
		const completePart = async (kept: CacheHit) => {
			const part = kept.part!;
			const asked = askedRange(requestHeaders.get('range'), part.size);
			if (asked === undefined || kept.mismatch) return null;
			const { from, to } = asked ?? { from: 0, to: part.size - 1 };
			// (the request and the part share no byte)
			if (from > part.to || to < part.from) return null;
			const holds = from >= part.from && to <= part.to;
			if (cacheMode === 'only-if-cached' && !holds) return null;
			const confirm =
				!takesStale &&
				(!holds || !kept.fresh || kept.revalidate || cacheMode === 'no-cache');
			if (confirm && !kept.etag && !kept.lastModified) return null;
			const keptBytes = new Uint8Array(await kept.response.arrayBuffer());
			const cookies: [string, string][] = [];
			const headers = new Headers(kept.response.headers);
			let asks = 0;
			let fetched = false;
			const ask = async (first: number, last: number, conditional: boolean) => {
				// (the bytes it lacks are asked for as of its version)
				const sent = conditional
					? withValidators(requestHeaders)
					: new Headers(requestHeaders);
				sent.set('range', `bytes=${first}-${last}`);
				if (!conditional)
					sent.set('if-range', (kept.etag ?? kept.lastModified)!);
				asks++;
				const upstream = await fetchUpstream(sent);
				for (const raw of upstream.rawHeaders ?? [])
					if (raw[0].toLowerCase() === 'set-cookie') cookies.push(raw);
				return upstream;
			};
			// the bytes it lacks, by range: a 206 of exactly them, of this version
			const lacking = async (first: number, last: number) => {
				const upstream = await ask(first, last, false);
				const got = contentRange(upstream.headers.get('content-range'));
				if (
					upstream.status === 206 &&
					got?.from === first &&
					got.to === last &&
					got.size === part.size &&
					sameVersion(kept.response.headers, upstream.headers)
				) {
					fetched = true;
					return new Uint8Array(await upstream.arrayBuffer());
				}
				if (upstream.status === 200) answered = upstream;
				else await upstream.body?.cancel().catch(() => {});
				return null;
			};
			// Bytes it lacks before the ones it holds: Chrome asks for them, then
			// drops the part and asks for what the page asked as the page asked
			// it, and keeps neither answer (measured in 152 and 156: the next
			// request is fetched again)
			if (from < part.from) {
				if (!kept.etag && !kept.lastModified) return null;
				const upstream = await ask(from, part.from - 1, false);
				await upstream.body?.cancel().catch(() => {});
				restarted = true;
				await cache!.drop(cacheKey!);
				answered = await fetchUpstream(new Headers(requestHeaders));
				return null;
			}
			const before = new Uint8Array();
			if (confirm) {
				const upstream = await ask(
					Math.max(from, part.from),
					Math.min(to, part.to),
					true,
				);
				if (upstream.status !== 304) {
					if (upstream.status === 200) answered = upstream;
					else await upstream.body?.cancel().catch(() => {});
					return null;
				}
				headers.delete('age');
				for (const [name, value] of upstream.headers)
					if (
						!['content-length', 'content-type', 'transfer-encoding'].includes(
							name,
						)
					)
						headers.set(name, value);
			}
			const after =
				to > part.to ? await lacking(part.to + 1, to) : new Uint8Array();
			if (!after) return null;
			// the bytes from the first it now has to the last
			const first = Math.min(from, part.from);
			const bytes = new Uint8Array(
				before.byteLength + keptBytes.byteLength + after.byteLength,
			);
			bytes.set(before);
			bytes.set(keptBytes, before.byteLength);
			bytes.set(after, before.byteLength + keptBytes.byteLength);
			if (asks) {
				headers.delete('age');
				if (!clears(headers))
					await cache!.putPart(
						cacheKey!,
						requestHeaders,
						new Response(null, { headers }),
						bytes,
						{ from: first, to: first + bytes.byteLength - 1, size: part.size },
					);
			}
			const slice = bytes.slice(from - first, to - first + 1);
			headers.set('content-length', String(slice.byteLength));
			if (asked)
				headers.set('content-range', `bytes ${from}-${to}/${part.size}`);
			else headers.delete('content-range');
			const completed: typeof response = new Response(slice, {
				status: asked ? 206 : 200,
				statusText: asked ? 'Partial Content' : 'OK',
				headers,
			});
			completed.rawHeaders = cookies;
			return { response: completed, asks, fetched };
		};
		let fromPart: Awaited<ReturnType<typeof completePart>> = null;
		if (hit?.part) {
			if (serverRequest.method === 'GET' && !fromWorker && !remembered)
				fromPart = await completePart(hit).catch((error) => {
					if (error === ABORTED) throw error;
					return null;
				});
			if (!fromPart) {
				await hit.response.body?.cancel().catch(() => {});
				hit = null;
			}
		}

		if (fromWorker) {
			response = fromWorker;
		} else if (remembered) {
			response = remembered;
			cached = true;
			memory = true;
		} else if (fromPart) {
			response = fromPart.response;
			cached = fromPart.asks === 0;
			revalidated = fromPart.asks > 0 && !fromPart.fetched;
		} else if (
			hit &&
			(takesStale
				? !hit.mismatch
				: hit.fresh && !hit.revalidate && cacheMode !== 'no-cache')
		) {
			// (must-revalidate is about a stale entry: a fresh one is used)
			response = hit.response;
			cached = true;
		} else if (cacheMode === 'only-if-cached' && !navigation) {
			await hit?.response.body?.cancel().catch(() => {});
			return Response.error();
		} else if (hit && within(hit.staleWhileRevalidate)) {
			response = hit.response;
			cached = true;
			// one revalidation per URL, however many stale hits arrive together
			cache!.revalidateOnce(cacheKey!, async () => {
				const upstream = await fetchUpstream(withValidators(requestHeaders));
				// (no page reads this answer: its cookies are set here)
				if (credentials)
					for (const [header, value] of upstream.rawHeaders ?? [])
						if (header.toLowerCase() === 'set-cookie')
							await rewriter.cookies.set(value, url.url, 'http', partitionKey);
				if (upstream.status === 304)
					await cache!.refresh(
						cacheKey!,
						hit,
						upstream.headers,
						requestHeaders,
					);
				else if (upstream.body && storable(upstream.status, upstream.headers))
					await cache!.put(cacheKey!, requestHeaders, upstream, upstream.body);
				else await upstream.body?.cancel();
			});
		} else {
			let upstream: Awaited<ReturnType<typeof rewriter.bare.fetch>>;
			try {
				upstream =
					preloaded ??
					answered ??
					(await fetchUpstream(withValidators(requestHeaders)));
				// a Basic challenge is answered once with the request's own
				// credentials, else the realm's kept ones; what succeeds is kept
				const realm =
					upstream.status === 401 && mayAuthenticate
						? basicRealm(upstream.headers.get('www-authenticate'))
						: null;
				const answer =
					realm === null
						? null
						: urlCredentials
							? basicAuthorization(urlCredentials)
							: authorizationForRealm(url.url, realm);
				if (answer && answer !== requestHeaders.get('authorization')) {
					await upstream.body?.cancel().catch(() => {});
					requestHeaders.set('authorization', answer);
					upstream = await fetchUpstream(withValidators(requestHeaders));
					if (upstream.status !== 401)
						rememberAuthorization(url.url, realm!, answer);
				}
				// a top-level answer whose Critical-CH names a hint its own
				// Accept-CH asks for and the request lacked: Chrome restarts the
				// navigation once with the hints
				if (navigation && topLevel && hintsContext.secure) {
					const accepted = await persistAcceptCH(
						url.url.origin,
						upstream.headers.get('accept-ch'),
					);
					if (
						criticalRetry(
							upstream.headers.get('critical-ch'),
							accepted,
							sentHints,
						)
					) {
						await upstream.body?.cancel().catch(() => {});
						sentHints = await applyClientHints(requestHeaders, hintsContext);
						upstream = await fetchUpstream(withValidators(requestHeaders));
					}
				}
			} catch (error) {
				if (error === ABORTED) {
					reportAborted();
					return Response.error();
				}
				// (a stale entry does not answer for it, stale-if-error or not:
				// Chrome shows the error)
				await hit?.response.body?.cancel().catch(() => {});
				// a document is reported by the wrapper, once it knows whether
				// the host's page answers (then no client id is to be waited for)
				if (!DOCUMENT_DESTINATIONS.has(serverRequest.destination)) {
					rewriter.log?.({
						url: reportURL(url),
						method: serverRequest.method,
						destination: serverRequest.destination || 'fetch',
						status: 0,
						ms: Date.now() - started,
						cached: false,
						kind: 'transport',
						bytes: null,
						error: String(error),
						client: context?.clientId,
					});
					(error as { stompReported?: boolean }).stompReported = true;
				}
				throw error;
			}
			if (hit && upstream.status !== 304)
				await hit.response.body?.cancel().catch(() => {});
			if (hit && upstream.status === 304) {
				response = await cache!.refresh(
					cacheKey!,
					hit,
					upstream.headers,
					requestHeaders,
				);
				// (the cookies a 304 sets are set, as any answer's)
				response.rawHeaders = upstream.rawHeaders?.filter(
					([header]) => header.toLowerCase() === 'set-cookie',
				);
				revalidated = true;
				memory = memoryKey !== null && rendererHas.has(memoryKey);
			} else if (restarted) {
				response = upstream;
			} else if (
				upstream.body &&
				cache &&
				cacheMode !== 'no-store' &&
				!clears(upstream.headers) &&
				isPartCacheable({
					method: serverRequest.method,
					requestHeaders,
					status: upstream.status,
					responseHeaders: upstream.headers,
				})
			) {
				// a part of the resource: kept as one (cache.ts putPart)
				const [forStore, forPage] = upstream.body.tee();
				const part = contentRange(upstream.headers.get('content-range'))!;
				const kept = upstream;
				new Response(forStore)
					.arrayBuffer()
					.then((bytes) =>
						bytes.byteLength === part.to - part.from + 1
							? cache.putPart(
									cacheKey!,
									requestHeaders,
									kept,
									new Uint8Array(bytes),
									part,
								)
							: undefined,
					)
					.catch(() => {});
				response = new Response(forPage, {
					status: upstream.status,
					statusText: upstream.statusText,
					headers: upstream.headers,
				});
				response.rawHeaders = upstream.rawHeaders;
			} else if (upstream.body && storable(upstream.status, upstream.headers)) {
				const [forStore, forPage] = upstream.body.tee();
				cache!.put(cacheKey!, requestHeaders, upstream, forStore);
				response = new Response(forPage, {
					status: upstream.status,
					statusText: upstream.statusText,
					headers: upstream.headers,
				});
				response.rawHeaders = upstream.rawHeaders;
			} else {
				response = upstream;
			}
		}

		// What a cache answers from an entry, as Chrome's does: a HEAD with
		// no body, and a request for a range of a kept 200's bytes with a 206
		// of them
		if (!fromWorker && (cached || revalidated)) {
			const { rawHeaders } = response;
			const part =
				serverRequest.method === 'HEAD'
					? null
					: await byteRange(response, requestHeaders.get('range'));
			if (part) response = part;
			else if (serverRequest.method === 'HEAD' && response.body) {
				await response.body.cancel().catch(() => {});
				response = new Response(null, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				});
			}
			response.rawHeaders = rawHeaders;
		}
		const cleared =
			!fromWorker && !cached && !revalidated && clears(response.headers);
		if (cleared) {
			await rewriter.cache?.clearOrigin(url.url.origin);
			memoryCache.clearOrigin(url.url.origin);
			for (const key of rendererHas)
				if (MemoryCache.origin(key) === url.url.origin) rendererHas.delete(key);
		}
		// what this site's renderer has from here on, fresh or not
		if (memoryKey !== null && response.status === 200 && !cleared) {
			rendererHas.delete(memoryKey);
			rendererHas.add(memoryKey);
			if (rendererHas.size > RENDERER_HAS)
				rendererHas.delete(rendererHas.values().next().value!);
		}
		// what the renderer would keep, from the network or the HTTP cache
		if (
			memoryKey !== null &&
			!remembered &&
			!fromWorker &&
			!cleared &&
			response.body &&
			MemoryCache.keeps(response.status, response.headers)
		) {
			const [kept, forPage] = response.body.tee();
			memoryCache
				.put(memoryKey, requestHeaders, response, kept)
				.catch(() => {});
			const teed: typeof response = new Response(forPage, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
			teed.rawHeaders = response.rawHeaders;
			response = teed;
		}

		if (
			!fromWorker &&
			rule &&
			rule.action !== 'block' &&
			rule.action.responseHeaders
		) {
			const headers = new Headers(response.headers);
			applyHeaderRule(headers, rule.action.responseHeaders);
			const edited: typeof response = new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
			edited.rawHeaders = response.rawHeaders;
			response = edited;
		}

		// the page gave up on this request while the origin was answering: the
		// body is cancelled (the transport stops reading) and the request is
		// reported as aborted; an abort after the headers went out cancels the
		// response stream the browser holds, which reaches the transport the
		// same way
		if (signal?.aborted) {
			await response.body?.cancel().catch(() => {});
			reportAborted();
			return Response.error();
		}

		// the document this navigation makes, as its requests' client hints
		// go: what it may send (a top-level one's Accept-CH is kept for its
		// origin first) and its Permissions-Policy, which the browser never
		// sees as the page sent it
		let navigated: ReturnType<typeof recordHintsDocument> | null = null;
		if (
			navigation &&
			DOCUMENT_DESTINATIONS.has(serverRequest.destination) &&
			!(
				REDIRECT_STATUSES.includes(response.status) &&
				response.headers.has('location')
			)
		) {
			const top = hintsTop ?? url.url.origin;
			const enabled = !hintsContext.secure
				? new Set<string>()
				: topLevel
					? await persistAcceptCH(top, response.headers.get('accept-ch'))
					: await acceptedHints(top);
			navigated = recordHintsDocument(serverRequest.url, context?.clientId, {
				origin: url.url.origin,
				top,
				topLevel,
				enabled,
				permissionsPolicy: response.headers.get('permissions-policy'),
				parent: hintsDoc,
				...(hintsContext.allow !== undefined
					? { allow: hintsContext.allow }
					: {}),
			});
		}

		// what the browser would not have let the page have: a cross-origin
		// cors response (or redirect) that does not pass the CORS check, a
		// no-cors one its Cross-Origin-Resource-Policy keeps to its own origin
		// or site. An answer of the page's emulated service worker is not the
		// network's: the worker's own fetches were judged as the worker's, and
		// what it hands the page goes as it is, with its type (handle fetch)
		const fromNetwork = !fromWorker;
		if (
			fromNetwork &&
			corsChecked &&
			!corsCheck(response.headers, corsOrigin!, credentialsIncluded)
		) {
			await response.body?.cancel().catch(() => {});
			return refuse('blocked by CORS policy');
		}
		if (
			fromNetwork &&
			crossOrigin &&
			policyMode === 'no-cors' &&
			corpBlocks(
				response.headers,
				policyOrigin!,
				url.url,
				policyOrigin !== 'null' &&
					initiator !== null &&
					siteBetween(initiator, url.url) !== 'cross-site',
			)
		) {
			await response.body?.cancel().catch(() => {});
			return refuse('blocked by Cross-Origin-Resource-Policy');
		}
		// the page's own embedder policy: under require-corp a no-cors
		// response of another origin, a redirect included, needs a resource
		// policy that lets the page have it, and a dedicated worker's script
		// (not a redirect on the way to it) a policy of its own (a shared
		// worker starts without one: measured)
		if (
			fromNetwork &&
			ownerPolicy &&
			((crossOrigin &&
				policyMode === 'no-cors' &&
				embedderPolicyBlocks(
					ownerPolicy.policy,
					response.headers,
					policyOrigin !== 'null' &&
						initiator !== null &&
						siteBetween(initiator, url.url) !== 'cross-site',
				)) ||
				(serverRequest.destination === 'worker' &&
					!REDIRECT_STATUSES.includes(response.status) &&
					embedderPolicy(
						response.headers.get('cross-origin-embedder-policy'),
					) === 'unsafe-none'))
		) {
			await response.body?.cancel().catch(() => {});
			return refuse('blocked by Cross-Origin-Embedder-Policy');
		}
		// a worker's own policy is its script's, for the loads it makes
		if (
			rewriter.isolated &&
			fromNetwork &&
			(serverRequest.destination === 'worker' ||
				serverRequest.destination === 'sharedworker') &&
			!REDIRECT_STATUSES.includes(response.status)
		) {
			const policy = embedderPolicy(
				response.headers.get('cross-origin-embedder-policy'),
			);
			rememberEmbedderPolicy(
				serverRequest.url,
				undefined,
				policy === 'unsafe-none' ? null : { policy },
			);
		}
		// a script of another origin that is HTML, XML or JSON by its type
		// and first bytes is not handed over (opaque response blocking): the
		// element fires `error`, as natively. And so for every load the
		// inject copies for a page, whatever it is for: natively such a
		// response never enters the page's process, and a copy's bytes do
		if (
			fromNetwork &&
			chainCrossed &&
			policyMode === 'no-cors' &&
			(serverRequest.destination === 'script' || copiedLoad) &&
			!REDIRECT_STATUSES.includes(response.status)
		) {
			let verdict = orbByHeaders(response.headers, response.status);
			// a video's or sound's copy keeps a URL the page's process can
			// fetch for as long as it plays (docs/same-origin-policy.md): only
			// what is media by its first bytes is handed over as one
			const mediaCopy =
				copiedLoad &&
				(load?.destination === 'video' || load?.destination === 'audio');
			if (mediaCopy && verdict !== 'block' && !response.body) verdict = 'block';
			if (
				(verdict === 'sniff' || (mediaCopy && verdict !== 'block')) &&
				response.body
			) {
				const { head, body } = await peekBody(response.body, ORB_SNIFF_BYTES);
				const peeked: typeof response = new Response(body, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				});
				peeked.rawHeaders = response.rawHeaders;
				response = peeked;
				if (
					(verdict === 'sniff' &&
						orbSniff(response.headers, response.status, head)) ||
					(mediaCopy && !orbMedia(head))
				)
					verdict = 'block';
			}
			if (verdict === 'block') {
				await response.body?.cancel().catch(() => {});
				return refuse('blocked by opaque response blocking');
			}
		}

		// Cross-origin isolation (src/isolation.ts), when the host's page is
		// isolated: every document needs an embedder policy to load there at
		// all, and is isolated natively only by its own headers (a top-level
		// one) and by what the document that embeds it lets it be (a nested
		// one, whose route says so). One whose embedder has an embedder policy
		// and that sent none, or that another origin's embedder may not have,
		// does not load, as natively.
		let isolation: (DocumentIsolation & { topLevel: boolean }) | null = null;
		// a redirect on the way to a frame needs no embedder policy, but one
		// of another origin than the embedder's still needs the resource
		// policy (measured)
		const navigationRedirect =
			REDIRECT_STATUSES.includes(response.status) &&
			response.headers.has('location');
		if (rewriter.isolated && navigation) {
			const real = isolationHeaders(response.headers);
			const origin = url.url.origin;
			if (topLevel) {
				if (!navigationRedirect)
					isolation = {
						...topLevelIsolation(real, origin),
						topLevel: destination === 'document',
					};
			} else {
				const mark = nestedMarkOf(oURL.pathname, rewriter.directory);
				const embedder = (mark !== null ? parseNestedMark(mark) : null)
					?.embedder ?? {
					origin: '',
					coep: false,
					group: false,
					delegates: 'none' as const,
					origins: [],
					credentialless: false,
					later: false,
				};
				let sameSite = false;
				try {
					sameSite =
						siteBetween(new URL(embedder.origin), url.url) !== 'cross-site';
				} catch (error) {
					// an embedder without an origin: another site
				}
				if (
					embedderRefuses(
						response.headers,
						origin,
						embedder,
						sameSite,
						navigationRedirect,
					)
				) {
					await response.body?.cancel().catch(() => {});
					return refuse('blocked by Cross-Origin-Embedder-Policy');
				}
				if (!navigationRedirect)
					isolation = {
						...nestedIsolation(real, origin, embedder),
						topLevel: false,
					};
			}
		}

		// the report is made now (its time is to the headers) and sent once the
		// body's transform has said how it went
		// the registration that controls the document this navigation makes:
		// its shell says so before the page's first script
		const note: Note = control ? { serviceWorker: control } : {};
		// what the document's shell tells its client of its isolation, and
		// its own embedder policy for the loads it makes
		if (isolation) {
			note.isolation = isolationFacts(isolation);
			rememberEmbedderPolicy(
				serverRequest.url,
				context?.clientId,
				isolation.coep === 'unsafe-none' ? null : { policy: isolation.coep },
			);
		}
		// what its Origin-Agent-Cluster asks for, a structured boolean (the
		// header itself never reaches the browser: filterHeaders.ts)
		const agentCluster = response.headers.get('origin-agent-cluster')?.trim();
		if (agentCluster === '?0') note.agentCluster = 'site';
		else if (agentCluster === '?1') note.agentCluster = 'origin';
		let report: RequestInfo | null = null;
		if (rewriter.log) {
			const length = Number(response.headers.get('content-length'));
			report = {
				url: reportURL(url),
				method: serverRequest.method,
				destination: serverRequest.destination || 'fetch',
				status: response.status,
				ms: Date.now() - started,
				cached,
				...(revalidated ? { revalidated: true } : {}),
				bytes: Number.isFinite(length) ? length : null,
				client: context?.clientId,
				...(rule ? { rule: rule.index } : {}),
			};
		}
		const sendReport = () => {
			if (report)
				rewriter.log!({
					...report,
					...(note.rewriteCache ? { rewriteCache: note.rewriteCache } : {}),
					...(note.rewriteIn ? { rewriteIn: note.rewriteIn } : {}),
					...(note.rewriteBy ? { rewriteBy: note.rewriteBy } : {}),
				});
			report = null;
		};

		// the media player's own warning, naming what the response holds
		if (mediaUpgraded && asked)
			postNotices(
				[
					{
						kind: 'should-also',
						type: /^\s*video\//i.test(
							response.headers.get('content-type') ?? '',
						)
							? 'video'
							: 'audio file',
						url: asked.href,
					},
				],
				context?.clientId,
				null,
			);

		let responseHeaders = filterResponseHeaders(
			response.headers,
			url,
			(target, base) => transformRoute(target, base, resource),
			additionalResponseFilter,
		);
		if (isolation) isolationResponseHeaders(responseHeaders, isolation);
		// what the document may not use, as the browser's own policy for it
		// (beside the isolation's `cross-origin-isolated=()`). A frame's needs
		// its element's allow attribute, which comes with the hint its parent
		// sends when it sets the frame's src (empty for none); a frame
		// navigation the worker has no container policy for (one the frame's
		// own document started, a redirect's next hop) is left to the browser
		const featuresOff =
			navigated &&
			(topLevel || hint?.allow !== undefined) &&
			browserPolicy(navigated);
		if (featuresOff) {
			const isolating = responseHeaders.get('permissions-policy');
			responseHeaders.set(
				'permissions-policy',
				isolating ? `${isolating}, ${featuresOff}` : featuresOff,
			);
		}
		// the browser asks the same of this redirect when the host's page is
		// of another origin than the proxy's
		else if (rewriter.isolated && navigation && navigationRedirect)
			responseHeaders.set('cross-origin-resource-policy', 'cross-origin');
		// a worker's script needs an embedder policy to start under a
		// document that has one (every proxied document, in an isolated host)
		else if (
			rewriter.isolated &&
			(serverRequest.destination === 'worker' ||
				serverRequest.destination === 'sharedworker')
		)
			responseHeaders.set('cross-origin-embedder-policy', 'credentialless');
		// the type an emulated service worker's answer has is the worker's to
		// say (serviceWorkers.dispatch); a site never says it
		if (fromNetwork) responseHeaders.delete(RESPONSE_TYPE_HEADER);
		// a load the page's emulated service worker answered with another
		// origin's opaque response taints a canvas that draws it
		else if (
			serverRequest.destination !== '' &&
			responseHeaders.get(RESPONSE_TYPE_HEADER)?.startsWith('opaque')
		)
			responseHeaders.append('server-timing', OPAQUE_MARKER);
		const redirect =
			REDIRECT_STATUSES.includes(response.status) &&
			responseHeaders.has('location');
		// a cors response of another origin shows the page only the headers
		// the protocol exposes (a redirect keeps its Location for the browser
		// to follow); a page's own no-cors fetch of another origin is opaque,
		// so nothing of the response reaches it (the inject shows it as one)
		const opaqueFetch =
			fromNetwork &&
			chainCrossed &&
			policyMode === 'no-cors' &&
			!internal &&
			serverRequest.destination === '' &&
			!redirect;
		// an emulated service worker's own no-cors fetch keeps the bytes (it
		// may hand them to an image of its page, or to its cache): its realm
		// shows the response as opaque and reads nothing of it
		const keepOpaqueBody =
			opaqueFetch &&
			serviceWorkers.isEmulated(context?.clientId, clientRoute ?? undefined);
		// another origin's timing the page may see (its Timing-Allow-Origin
		// names the page): the inject reads the marks below
		const timingShown =
			fromNetwork &&
			crossOrigin &&
			timingAllowed(response.headers, policyOrigin!);
		if ((fromNetwork && corsChecked) || opaqueFetch) {
			const location = responseHeaders.get('location');
			const serverTiming = responseHeaders.get('server-timing');
			responseHeaders = opaqueFetch
				? new Headers()
				: exposedHeaders(responseHeaders, credentialsIncluded);
			if (redirect && location !== null)
				responseHeaders.set('location', location);
			// the browser takes the entry's Server-Timing from the headers it
			// gets: kept for it, hidden from the page's reads of the headers
			if (
				timingShown &&
				serverTiming !== null &&
				!responseHeaders.has('server-timing')
			)
				responseHeaders.set(
					'server-timing',
					`${serverTiming}, ${TIMING_ONLY_MARKER}`,
				);
		}
		// a no-cors load (an image, a video) that came through another origin
		// is that origin's to the page whatever origin its last hop is of: the
		// element's URL is its first one, so the inject reads this mark (a
		// canvas that draws it is tainted), as for an opaque answer of the
		// page's emulated service worker
		// (a page's no-cors fetch of the same chain is opaque: its URLs are
		// the page's own origin's, so the inject's fetch reads the mark too,
		// and so does the copy the inject makes of a load for a document no
		// worker controls)
		if (
			fromNetwork &&
			previousHop &&
			chainCrossed &&
			policyMode === 'no-cors' &&
			(serverRequest.destination !== '' || opaqueFetch || internal) &&
			!redirect
		)
			responseHeaders.append('server-timing', OPAQUE_MARKER);
		// (a video or sound says so before its load is over, which is when the
		// mark can be read: the inject asks, mediaLoads.ts)
		if (
			!redirect &&
			(serverRequest.destination === 'video' ||
				serverRequest.destination === 'audio') &&
			responseHeaders.get('server-timing')?.includes(OPAQUE_MARKER)
		)
			await recordCrossedMedia(previousHop?.first ?? serverRequest.url);
		// the page's resource timing of another origin's load is restricted
		// unless its Timing-Allow-Origin names the page: the inject reads this
		// mark (and takes it out of the headers a fetch or XHR shows)
		if (timingShown) responseHeaders.append('server-timing', TAO_MARKER);
		// a copy of a load the page may not read says so to the inject that
		// asked for it, which keeps the copy out of the page's reach (only a
		// granted request's answer carries the header)
		responseHeaders.delete(OPAQUE_COPY_HEADER);
		if (
			copiedLoad &&
			!redirect &&
			(fromNetwork
				? chainCrossed && policyMode === 'no-cors'
				: !!responseHeaders.get(RESPONSE_TYPE_HEADER)?.startsWith('opaque'))
		)
			responseHeaders.set(OPAQUE_COPY_HEADER, 'opaque');
		// an answer from the worker's own caches reads as the browser's cache
		// hit in resource timing (CACHED_MARKER)
		if (cached && !redirect)
			responseHeaders.append('server-timing', CACHED_MARKER);
		// and one the origin confirmed with a 304 as the browser's revalidated
		// entry (REVALIDATED_MARKER)
		if (revalidated && !redirect)
			responseHeaders.append('server-timing', REVALIDATED_MARKER);
		if (memory && !redirect)
			responseHeaders.append('server-timing', MEMORY_MARKER);
		// an XMLHttpRequest's entry names its initiator (XHR_MARKER)
		if (requestTypeOf(serverRequest) === 'XMLHttpRequest endpoint' && !redirect)
			responseHeaders.append('server-timing', XHR_MARKER);

		// A redirect goes out without its Content-Length, which no page can
		// read: Chrome's media loader gives up on a video or sound over 64 KiB
		// whose redirect a service worker answered with `Content-Length: 0`
		// (measured with a plain worker, without the proxy)
		if (redirect) responseHeaders.delete('content-length');

		// the browser follows the redirect in proxy URL space, where every hop
		// is same-origin and the referrer never narrows: remember what this hop
		// sent and its site, so a chain through another origin keeps both
		if (redirect)
			rememberRedirect(
				hopClient,
				serverRequest.referrer,
				responseHeaders.get('location')!,
				serverRequest.url,
				{
					...(carried !== undefined || refererSource ? { referer } : {}),
					site,
					user: activated,
					// a chain only a hint named the initiator of keeps it
					...(!known && initiator ? { initiator: initiator.origin } : {}),
					...(crossOrigin &&
					(previousHop?.tainted ||
						crossOriginLocation(response.headers.get('location'), url))
						? { tainted: true }
						: {}),
					...(chainCrossed ? { crossed: true } : {}),
					...(granted !== null && loadToken !== null
						? { grant: { token: loadToken, load: granted } }
						: {}),
					first: previousHop?.first ?? serverRequest.url,
				},
			);

		// a navigation that began at a link route (src/visited.ts) goes on
		// through the link route of the URL the site redirected to, in the
		// same context: Chrome records every URL of a redirect chain under the
		// navigation's own key. The hop above is kept by the document's
		// address, which that link route redirects to in turn
		const visitedHop = navigation ? takeVisitedHop(serverRequest.url) : null;
		// the redirects that were link routes are the worker's, not the
		// site's: the page's navigation timing takes them off (HOPS_MARKER)
		if (visitedHop && !redirect)
			responseHeaders.append(
				'server-timing',
				// (every redirect, when the site's own crossed origins: none
				// is shown then)
				`${HOPS_MARKER};dur=${visitedHop.crossed ? 99 : visitedHop.hops}`,
			);
		if (redirect && navigation) {
			const hop = visitedHop;
			try {
				const next =
					hop &&
					parseRoutedURL(
						new URL(responseHeaders.get('location')!, serverRequest.url).href,
						rewriter.codec,
						routedPrefix,
					);
				if (hop && next && /^html(:nested:[^/]*)?$/.test(next.resource)) {
					const link = linkRoute(
						`${oURL.origin}${rewriter.config.scope}`,
						rewriter.codec,
						contextText(hop.context, publicSuffix),
						next.url.url,
					);
					rememberVisitedHop(link, {
						context: hop.context,
						directory: rewriter.directory,
						nested: nestedMarkOfKind(next.resource) ?? false,
						hops: hop.hops,
						...((hop.crossed || next.url.url.origin !== url.url.origin) && {
							crossed: true,
						}),
					});
					responseHeaders.set('location', link);
				}
			} catch (error) {
				// a Location that is no route: as it is
			}
		}

		// preloads announced by the server fetch through the proxy too
		if (responseHeaders.has('link'))
			responseHeaders.set(
				'link',
				rewriteLinkHeader(responseHeaders.get('link')!, (target, params) => {
					const resource = new StompURL(new URL(target, url.toString()), url);
					if (params.as === 'style') return routeCSS(resource, url);
					if (params.rel === 'modulepreload')
						return routeJS(resource, url, rewriter.config, 'genericModule');
					if (params.as === 'script')
						return routeJS(resource, url, rewriter.config, 'generic');
					if (params.as === 'document' || params.rel === 'prefetch')
						return routeHTML(resource, url, rewriter.config);
					return routeBinary(resource);
				}),
			);

		// an EventSource must get its MIME type even from a server that
		// forgot it, or the browser drops the stream
		if (
			(serverRequest.headers.get('accept') || '').includes('text/event-stream')
		)
			responseHeaders.set('content-type', 'text/event-stream');

		for (const [header, value] of response.rawHeaders ?? []) {
			if (header.toLowerCase() === 'set-cookie') {
				// a response to a request without credentials sets nothing
				if (credentials)
					await rewriter.cookies.set(
						value,
						url.url,
						'http',
						partitionKey,
						crossSiteSet,
					);
			}
		}

		// A frame's navigation the site redirects to another origin: the frame
		// gets a fresh browsing context for it (src/freshFrame.ts), which asks
		// for the redirect's target as the navigation's next hop (its
		// referrer and policy put back from here, as for a return)
		if (
			redirect &&
			navigation &&
			!topLevel &&
			(destination === 'iframe' || destination === 'frame') &&
			crossOriginLocation(response.headers.get('location'), url)
		) {
			await response.body?.cancel().catch(() => {});
			const to = new URL(responseHeaders.get('location')!, serverRequest.url)
				.href;
			rememberReturn(to, {
				// the key the redirect's hop is kept under (rememberRedirect)
				referrer: serverRequest.referrer,
				policy,
				url: to,
				fresh: true,
			});
			const headers = new Headers({
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store',
			});
			isolationResponseHeaders(headers, { isolated: false, topLevel: false });
			return new Response(freshFrameDocument(to), { headers });
		}

		let body: BodyInit | undefined;
		/** the transform's output when it is text: a rewrite made just now */
		let rewritten: string | null = null;

		if (statusEmpty.includes(+response.status)) {
			body = undefined;
		} else if (opaqueFetch && !keepOpaqueBody) {
			await response.body?.cancel().catch(() => {});
			body = undefined;
		} else {
			let output: BodyInit | false;
			try {
				output = transformBody
					? await transformBody(
							url,
							response,
							responseHeaders,
							referrerInfo,
							{
								method: serverRequest.method,
								headers: requestHeaders,
								routed: serverRequest.url,
								clientId: context?.clientId,
								navigation,
								upgradeInsecure,
								partition:
									frameSite === null
										? null
										: JSON.stringify([
												topSite ?? frameSite,
												frameSite,
												credentials,
											]),
							},
							note,
						)
					: false;
			} catch (error) {
				sendReport();
				throw error;
			}
			// a script the rewrite cache kept as the response it was given, which
			// says what this one would: it goes out as it is (V8's code cache
			// comes with it). A hop of a redirect chain takes its body instead
			const stored = note.served?.stored;
			if (stored) {
				if (!previousHop) {
					// the same document asking again (its parser, after its
					// preload scanner) is given the entry again
					if (recentKey !== null)
						rememberOutput(recentKey, {
							body: new Blob(),
							status: stored.status,
							statusText: stored.statusText,
							headers: [],
							bytes: Number(stored.headers.get('content-length')) || null,
							served: { url: note.served!.url, key: note.served!.key },
						});
					sendReport();
					// the entry is the store's own Response and says nothing of
					// this load: how it was delivered is noted for the inject,
					// for when the page reads its timing (keptLoads.ts)
					noteKeptLoad(
						serverRequest.url,
						cached
							? memory
								? 'memory'
								: 'cache'
							: revalidated
								? memory
									? 'memory-revalidated'
									: 'revalidated'
								: 'network',
						context?.clientId,
					);
					return stored;
				}
				output = await stored.blob();
				note.served!.stored = null;
			}
			// text goes out as its UTF-8 bytes, encoded once, natively: the
			// length is theirs (counting it in JS took 0.2 s for YouTube's 20 MB
			// bundle) and the Response has nothing left to encode
			if (typeof output === 'string') rewritten = output;
			const encoded = typeof output === 'string' ? UTF8.encode(output) : null;
			const transformed = encoded ?? output;

			body = transformed !== false ? transformed : response.body!;

			// The origin's Content-Length counts the origin's bytes, and a
			// transformed body is the worker's own: it goes out with its own
			// length, or none when that is not known before it is read. A HEAD
			// has no body to transform, so the length of what the GET would get
			// is unknown and goes. A body passed through keeps the origin's.
			if (transformed !== false) {
				const length =
					serverRequest.method === 'HEAD' ? null : bodyLength(transformed);
				if (length === null) responseHeaders.delete('content-length');
				else responseHeaders.set('content-length', String(length));
			}

			// A rewritten body is this worker's output, not the origin's: the
			// browser's HTTP cache must not keep it for as long as the origin
			// allowed (a rewriter upgrade or new helper names would leave old
			// output in it for a year). no-cache makes the browser ask again;
			// the validators stay, and the worker answers from its own cache
			// of the upstream bytes, so the revalidation costs no network.
			if (transformed !== false) {
				responseHeaders.set('cache-control', 'no-cache');
				responseHeaders.delete('expires');
				responseHeaders.delete('age');
			}
			const kept = encoded ?? (output instanceof Blob ? output : null);
			if (
				recentKey !== null &&
				kept !== null &&
				response.status === 200 &&
				!previousHop
			)
				rememberOutput(recentKey, {
					body: kept,
					status: response.status,
					statusText: response.statusText,
					headers: [...responseHeaders],
					bytes: Number(responseHeaders.get('content-length')) || null,
				});
		}

		// what the renderer keeps in its memory cache is the worker's to hand
		// out again, per site (MemoryCache): the browser asks for it each
		// document, and has no validators to make it a revalidation of a copy
		// another site's document loaded
		if (memoryDestination) {
			responseHeaders.set('cache-control', 'no-cache');
			for (const name of ['expires', 'age', 'etag', 'last-modified'])
				responseHeaders.delete(name);
		}

		// a script the rewrite cache keeps as the response it was given: this
		// one, for the next load of its URL (see the transform's hit above).
		// One that is not what a load of its URL gets (a hop of a redirect
		// chain, a HEAD, another status) keeps its rewrite under its key
		const served = note.served;
		if (served && body !== undefined) {
			const size =
				serverRequest.method === 'GET' &&
				response.status === 200 &&
				!previousHop
					? bodyLength(body)
					: null;
			if (size !== null)
				void rewriter.rewrites?.putServed(
					served.url,
					served.key,
					served.partition,
					body,
					size,
					{
						status: response.status,
						statusText: response.statusText,
						headers: keptHeaders(responseHeaders),
					},
				);
			else if (rewritten !== null)
				void rewriter.rewrites?.put(served.key, rewritten);
		}

		sendReport();
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: responseHeaders,
		});
	};
	// a transport failure surfaces wherever the connection's promise was
	// awaited (the headers, the body, a cache write): for a document it is one
	// failure to the user, shown the host's way; the router keeps the errors
	// that are ours (a bug, an HTTP error of the routing)
	return async function (
		serverRequest: Request,
		resolved?: string,
		context?: RouteContext,
	): Promise<Response> {
		const started = Date.now();
		const abortId = serverRequest.headers.get(ABORT_HEADER);
		try {
			return await forward(serverRequest, resolved, context);
		} catch (error) {
			if (error === ABORTED) return Response.error();
			if (
				!DOCUMENT_DESTINATIONS.has(serverRequest.destination) ||
				!(error instanceof Error) ||
				error instanceof TypeError ||
				error instanceof ReferenceError ||
				error instanceof RangeError ||
				error instanceof SyntaxError ||
				'status' in error
			)
				throw error;
			let real = serverRequest.url;
			try {
				real = reportURL(
					parseRoutedURL(
						serverRequest.url,
						rewriter.codec,
						`${new URL(serverRequest.url).origin}${rewriter.directory}`,
					).url,
				);
			} catch (parseError) {
				// not a routed URL after all: reported as it came
			}
			// the report says 0 (no response); the document needs a status: 502
			const page = await hostErrorPage(rewriter, {
				url: real,
				status: 502,
				error: String(error),
				kind: 'transport',
			});
			if (!(error as { stompReported?: boolean }).stompReported)
				rewriter.log?.({
					url: real,
					method: serverRequest.method,
					destination: serverRequest.destination || 'fetch',
					status: 0,
					ms: Date.now() - started,
					cached: false,
					kind: 'transport',
					bytes: null,
					error: String(error),
					// the host's page never reports a client id: no attribution to wait for
					...(page ? {} : { client: context?.clientId }),
				});
			if (page) return page;
			throw error;
		} finally {
			if (abortId) pendingAborts.delete(abortId);
		}
	};
}

/**
 * Whether the UTF-8 `bytes` contain the ASCII `text` (a helper name): an
 * ASCII byte is never part of a multi-byte sequence, so this is whether the
 * decoded text contains it.
 */
function includesASCII(bytes: Uint8Array, text: string): boolean {
	if (!text) return true;
	const first = text.charCodeAt(0);
	const last = bytes.length - text.length;
	for (
		let at = bytes.indexOf(first);
		at !== -1 && at <= last;
		at = bytes.indexOf(first, at + 1)
	) {
		let i = 1;
		while (i < text.length && bytes[at + i] === text.charCodeAt(i)) i++;
		if (i === text.length) return true;
	}
	return false;
}

const htmlMimes = ['text/html', '', ...XML_DOCUMENT_MIMES];

/**
 * Rewritten outputs a document was just given, by what it asked for, so the
 * same request from the same document a moment later gets the same answer
 * without the worker reading, hashing or rewriting anything again. A
 * rewritten body goes out no-cache, and the browser never revalidates for
 * a page a service worker controls: it asks again in full. So every script
 * and stylesheet the preload scanner fetched while the parser was held up
 * (by a stylesheet, a slow script) was fetched again when the parser got
 * there: on YouTube each of them, its 20 MB bundle and 3 MB stylesheet
 * among them, went through the worker twice per load. Natively the
 * document reuses what its preload scanner fetched. Kept for RECENT_MS, at
 * most RECENT_BYTES in all, oldest out first; a navigation is never answered
 * from here, and a request that bypasses caches is not either.
 */
interface RecentOutput {
	/** the bytes (a new Response copies them), or the rewrite cache's Blob */
	body: Uint8Array<ArrayBuffer> | Blob;
	status: number;
	statusText: string;
	headers: [string, string][];
	bytes: number | null;
	/** the output is the rewrite cache's entry for this URL and key (RewriteCache.matchServed), given as it is: no body is kept here */
	served?: { url: string; key: string };
}
const RECENT_MS = 30 * 1000;
const outputSize = (body: Uint8Array<ArrayBuffer> | Blob) =>
	body instanceof Blob ? body.size : body.byteLength;
const RECENT_BYTES = 64 * 1024 * 1024;
const UTF8 = new TextEncoder();
const recentOutputs = new Map<string, RecentOutput & { at: number }>();
let recentBytes = 0;

/** what makes two requests the same request of the same document, or null for one that is never answered from what it was given before */
function recentOutputKey(
	request: Request,
	context?: RouteContext,
): string | null {
	if (
		request.method !== 'GET' ||
		request.mode === 'navigate' ||
		!context?.clientId ||
		request.headers.has(LOAD_HEADER) ||
		(request.cache !== undefined && request.cache !== 'default')
	)
		return null;
	return [
		context.clientId,
		request.url,
		request.destination,
		request.mode,
		request.credentials,
		// what the same-origin policy decides by, past the client's origin
		// (the client id) and the mode and credentials above: whether it is
		// of an opaque origin, and the page's headers that would need a
		// preflight (a request that names a load grant is never answered
		// from here: its grant is taken once)
		request.headers.has(OPAQUE_HEADER) ? 'opaque' : '',
		unsafeHeaderNames(request.headers, notPagesHeader).join(','),
	].join('\u0000');
}

function takeRecentOutput(key: string): RecentOutput | null {
	const kept = recentOutputs.get(key);
	if (!kept) return null;
	if (Date.now() - kept.at > RECENT_MS) {
		recentOutputs.delete(key);
		recentBytes -= outputSize(kept.body);
		return null;
	}
	return kept;
}

function rememberOutput(key: string, output: RecentOutput) {
	if (outputSize(output.body) > RECENT_BYTES) return;
	const old = recentOutputs.get(key);
	if (old) {
		recentOutputs.delete(key);
		recentBytes -= outputSize(old.body);
	}
	recentOutputs.set(key, { ...output, at: Date.now() });
	recentBytes += outputSize(output.body);
	const now = Date.now();
	for (const [kept, entry] of recentOutputs) {
		if (recentBytes <= RECENT_BYTES && now - entry.at <= RECENT_MS) break;
		recentOutputs.delete(kept);
		recentBytes -= outputSize(entry.body);
	}
}

/** what the worker gave documents before stands for nothing now (the host's rules changed) */
function forgetRecentOutputs() {
	recentOutputs.clear();
	recentBytes = 0;
}

/**
 * Headers no browser acts on when it loads a script, which change from one
 * response to the next for the same bytes (a date, a CDN's request id): a
 * kept script response (RewriteCache.matchServed) does not carry them, so
 * nothing of the request it was made from reaches a later one, and one
 * that differs from a new response only in these is the same to the page
 */
const UNACTED_HEADERS = new Set([
	'age',
	'akamai-grn',
	'alt-svc',
	'connection',
	'date',
	'etag',
	'expires',
	'keep-alive',
	'last-modified',
	'nel',
	'report-to',
	'reporting-endpoints',
	'request-id',
	'server',
	'traceparent',
	'tracestate',
	'via',
]);
/** the x- headers a browser (or the inject: the worker's own) does act on */
const ACTED_X_HEADERS = new Set([
	RESPONSE_TYPE_HEADER,
	'x-content-type-options',
	'x-frame-options',
	'x-sourcemap',
	'x-xss-protection',
]);
const actedOn = (name: string) =>
	!UNACTED_HEADERS.has(name) &&
	!name.startsWith('cf-') &&
	(!name.startsWith('x-') || ACTED_X_HEADERS.has(name));
/** the worker's own Server-Timing marks, which the inject reads */
const OWN_MARKS = [TAO_MARKER, OPAQUE_MARKER];

/**
 * The headers a kept script response has, of the ones the page is given
 * (`headers`): the ones a browser acts on. Of Server-Timing, which a page
 * reads from its resource timing, only the worker's own marks: the origin's
 * metrics are one request's, and a later load is not given them as its own.
 */
function servedHeaders(headers: Headers): Headers {
	const out = new Headers();
	for (const [name, value] of headers)
		if (name !== 'server-timing' && actedOn(name)) out.append(name, value);
	const marks = (headers.get('server-timing') ?? '')
		.split(',')
		.map((metric) => metric.trim())
		.filter((metric) => OWN_MARKS.includes(metric));
	if (marks.length) out.set('server-timing', marks.join(', '));
	return out;
}

/**
 * The headers of the response the rewrite cache keeps for a script: what a
 * later load is given of them (servedHeaders), and the mark that says the
 * response is a kept one, whose delivery the worker tells the inject apart
 * from it (KEPT_MARKER; not one of the marks two responses are compared by)
 */
function keptHeaders(headers: Headers): Headers {
	const out = servedHeaders(headers);
	out.append('server-timing', KEPT_MARKER);
	return out;
}

/** what the forward sets itself on a rewritten body, whatever the origin said */
const FORWARD_HEADERS = new Set([
	'age',
	'cache-control',
	'content-length',
	'expires',
]);

/**
 * whether a kept script response says what a new one would, whose headers
 * before the transform are `fresh`
 */
function sameServedHeaders(kept: Headers, fresh: Headers): boolean {
	const list = (headers: Headers) =>
		JSON.stringify(
			[...servedHeaders(headers)].filter(
				([name]) => !FORWARD_HEADERS.has(name),
			),
		);
	return list(kept) === list(fresh);
}

/** the bytes `body` goes out as, or null when that is not known before it is read */
export function bodyLength(body: BodyInit): number | null {
	if (typeof body === 'string') return utf8Length(body);
	if (body instanceof Blob) return body.size;
	if (body instanceof ArrayBuffer) return body.byteLength;
	if (ArrayBuffer.isView(body)) return body.byteLength;
	return null;
}

/** how many bytes `text` is in UTF-8 (a lone surrogate goes out as U+FFFD, three) */
function utf8Length(text: string): number {
	let length = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x80) length += 1;
		else if (code < 0x800) length += 2;
		else if (
			code >= 0xd800 &&
			code <= 0xdbff &&
			i + 1 < text.length &&
			(text.charCodeAt(i + 1) & 0xfc00) === 0xdc00
		) {
			length += 4;
			i++;
		} else length += 3;
	}
	return length;
}

export function getMime(contentType: string): string {
	return contentType.split(';')[0];
}

/**
 * `markup` with a `<meta http-equiv="refresh">` carrying `value` as the first
 * thing after its doctype (before it, the page would lose standards mode).
 */
export function withRefreshMeta(markup: string, value: string): string {
	const meta = `<meta http-equiv="refresh" content="${value
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')}">`;
	const doctype = /^(\uFEFF?\s*<!doctype[^>]*>)/i.exec(markup);
	return doctype
		? `${doctype[1]}${meta}${markup.slice(doctype[1].length)}`
		: `${meta}${markup}`;
}

export function registerRewrites(
	router: Router,
	init: ParsedConfig,
	cookies: Cookies,
	transport: ProxyTransport,
	cache?: HttpCache,
	log?: (info: RequestInfo) => void,
	rewrites?: RewriteCache,
	pool?: RewritePool,
	blocker?: Blocker,
	blockerAsked = true,
) {
	const rewriter: Rewriter = {
		get config() {
			return {
				directory: this.directory,
				scope: init.scope,
				codec: codecType(this.codec),
				frameAncestors: init.frameAncestors,
				...(init.openTab ? { openTab: true } : {}),
				// the host's page is cross-origin isolated: a document says whom
				// it embeds (src/isolation.ts)
				...(init.isolated ? { isolated: true } : {}),
				// the pages' synchronous requests complete (a written script in
				// a document no worker controls is copied at once)
				...(init.workerTransport ? { workerTransport: true } : {}),
				...(init.allowInvalidJs === false ? { allowInvalidJs: false } : {}),
				// every document's inject builds the window membrane from this
				...(init.membrane === false ? { membrane: false } : {}),
				// pages get emulated service workers (docs/service-workers.md)
				...(init.serviceWorkers === false ? { serviceWorkers: false } : {}),
				// the wasm rewriters answer where a thread holds them
				...(init.rewriter === 'wasm' ? { rewriter: 'wasm' as const } : {}),
				...(init.assets ? { assets: init.assets } : {}),
				// the blocker is on: every document's inject takes its natives
				// for the cosmetic rules before it hooks anything
				...(init.adblock ? { adblock: true } : {}),
				// the deployment's helper names: the shell and every rewritten
				// script use them, and the inject reads them from this config
				...(init.names ? { names: init.names } : {}),
				// the host's hooks: every shell and worker preamble runs them
				...(init.hooks ? { hooks: init.hooks } : {}),
				build: BUILD,
			};
		},
		cookies,
		cache,
		rewrites,
		pool,
		log,
		rules: [],
		blocker,
		blockerAsked,
		isolated: !!init.isolated,
		codec: init.codec,
		directory: init.directory,
		errorPage: init.errorPage,
		names: init.names,
		bare: new BareCompatibleClient(transport),
	};

	// binary:set is a srcset candidate (routeImageSet), loaded the same way
	router.routes.set(
		/^\/binary(?::set)?\//,
		genericForward(
			rewriter,
			undefined,
			(resource) => routeBinary(resource),
			undefined,
			undefined,
		),
	);

	// used by the controller (over RPC) to turn a URL into a frame destination
	const route = (url: string) => {
		const surl = new StompURL(url, rewriter.codec, rewriter.directory);
		return routeHTML(surl, surl, rewriter.config);
	};

	// a script's rewritten output comes from the rewrite cache when the same
	// body was rewritten before for the same URL, type and config; it is kept
	// only when the response may be kept at all (the HTTP cache's rules)
	// a script is rewritten by one of the controller's rewrite workers when
	// one is live and answers in time, here otherwise: the same output
	const rewriteScript = async (
		text: string,
		url: StompURL,
		type: ScriptType,
		note: Note,
	): Promise<string> => {
		let split = false;
		const told: RewrittenBy = {};
		const pooled = rewriter.pool?.live
			? await rewriter.pool.rewrite(
					text,
					url,
					rewriter.config,
					type,
					() => (split = true),
					told,
				)
			: null;
		note.rewriteIn =
			pooled === null ? 'service-worker' : split ? 'pool split' : 'pool';
		const output =
			pooled ??
			modifyJS(
				text,
				url,
				rewriter.config,
				type,
				'',
				undefined,
				undefined,
				told,
			);
		// which backend made it: the module, or the JavaScript rewriter (the
		// module declined the script, the thread held none, or the script was
		// split, whose parts are the JavaScript rewriter's)
		if (rewriter.config.rewriter === 'wasm') note.rewriteBy = told.by ?? 'js';
		return output;
	};
	// the config a script's rewrite depends on, for its cache key: all of it
	// but the client's name, which a controller mints anew (a host that keeps
	// its id across a reload would miss every script). A page script's
	// output names it only where the body mentions it (the rewriter routes
	// it); a worker's preamble always does
	const cacheConfig = (
		config: Config,
		type: ScriptType,
		mentions: (name: string) => boolean,
	) => {
		const client = config.names?.client;
		if (
			client === undefined ||
			type === 'worker' ||
			type === 'workerModule' ||
			mentions(client)
		)
			return JSON.stringify(config);
		return JSON.stringify({
			...config,
			names: { ...config.names, client: undefined },
		});
	};
	// a document's inline scripts and styles, rewritten here (src/prewrite.ts):
	// the scripts by the rewrite workers, side by side, and kept in the
	// rewrite cache for `partition` (null: the document may not be kept, or
	// its request has no partition); null when no worker is
	// live (the worker's own thread is not spent on them: the page rewrites
	// them as before). `dispatched`: every script is with a worker (or came
	// from the cache), so this thread may do other work while they rewrite;
	// `finish` rewrites the styles here and waits for the scripts
	const prewrite = (
		markup: string,
		url: StompURL,
		partition: string | null,
	): {
		dispatched: Promise<void>;
		finish: () => Promise<Prewritten>;
	} | null => {
		const pool = rewriter.pool;
		if (!pool?.live) return null;
		const config = rewriter.config;
		// `rewriter: 'wasm'`: one pass of the scanner over the markup in place
		// of the three expressions, and the same answer
		const wasm = config.rewriter === 'wasm';
		const scanned = wasm ? scanMarkup(markup) : null;
		if (scanned ? scanned.base : hasBase(markup)) return null;
		const { scripts, styles } = inlineSources(markup, scanned ?? undefined);
		if (!scripts.length && !styles.length) return null;
		const rewrites = partition !== null ? rewriter.rewrites : undefined;
		const encoder = new TextEncoder();
		const dispatches: Promise<void>[] = [];
		const access = helperNames(config).access;
		const outputs = scripts.map(
			async ([kind, source, start, end]): Promise<
				Prewritten['scripts'][number] | null
			> => {
				const entry = (output: string): Prewritten['scripts'][number] => [
					kind,
					start,
					end,
					...packRewrite(kind, source, output, access),
				];
				let sent!: () => void;
				dispatches.push(new Promise((resolve) => (sent = resolve)));
				try {
					const type: ScriptType = kind === 'm' ? 'genericModule' : 'generic';
					const preamble = kind === 'm' ? '' : scriptPreamble(source);
					const key = rewrites
						? await rewrites.key(
								[
									BUILD,
									url.toString(),
									type,
									'inline',
									cacheConfig(config, type, (name) => source.includes(name)),
									url.codec.key,
									partition!,
								],
								encoder.encode(source),
							)
						: null;
					const kept = key !== null ? await rewrites!.match(key) : null;
					if (kept !== null) return entry(await kept.text());
					const rewriting = pool.rewriteInline(
						source,
						url,
						config,
						type,
						preamble,
					);
					sent();
					const output = await rewriting;
					if (output === null || output === source) return null;
					if (key !== null) void rewrites!.put(key, output);
					return entry(output);
				} finally {
					sent();
				}
			},
		);
		// a failure is finish's to report
		for (const output of outputs) output.catch(() => {});
		return {
			dispatched: Promise.all(dispatches).then(() => {}),
			finish: async () => {
				// the module, when it is still being compiled
				if (wasm && styles.length) await scannerSettled();
				// as the client's prepareStyleText makes them
				const styleOutputs = styles.map(
					([source, start, end]): Prewritten['styles'][number] => {
						try {
							return [
								start,
								end,
								modifyCSS(source, url, 'stylesheet', wasm ? {} : undefined),
							];
						} catch (error) {
							return [start, end, rewriteCSSValueURLs(source, url)];
						}
					},
				);
				const done = await Promise.all(outputs);
				return {
					url: url.toString(),
					scripts: done.filter(
						(entry): entry is Prewritten['scripts'][number] => entry !== null,
					),
					styles: styleOutputs,
				};
			},
		};
	};
	const scriptTypeFactory = (type: ScriptType) =>
		genericForward(
			rewriter,
			async (url, response, headers, _referrer, request, note) => {
				if (!response.ok) return false;
				const rewrites = rewriter.rewrites;
				const partition = request.partition;
				if (
					!rewrites ||
					partition === null ||
					!mayKeep({
						method: request.method,
						requestHeaders: request.headers,
						status: response.status,
						responseHeaders: response.headers,
					})
				) {
					note.rewriteCache = 'skip';
					return rewriteScript(await response.text(), url, type, note);
				}
				// The key is a digest of the bytes as they came, and a script kept
				// rewritten goes out as the store's own Response: a hit decodes
				// nothing and makes no string of the output (YouTube's bundle is
				// 10 MB in and 20 MB out, read, decoded and encoded again on
				// every load).
				const bytes = new Uint8Array(await response.arrayBuffer());
				const key = await rewrites.key(
					[
						BUILD,
						url.toString(),
						type,
						cacheConfig(rewriter.config, type, (name) =>
							includesASCII(bytes, name),
						),
						url.codec.key,
						partition,
					],
					bytes,
				);
				// kept as the response for this very URL: given as it is (the
				// forward), so its compiled code comes along; or kept under its
				// key (another partition's load of this URL took its place); else
				// rewritten. Whatever the page gets is kept under its URL behind
				// it (the forward)
				const served = await rewrites.matchServed(request.routed, key);
				note.served = { url: request.routed, key, partition, stored: null };
				if (served !== null) {
					note.rewriteCache = 'hit';
					if (
						request.method === 'GET' &&
						response.status === 200 &&
						served.status === 200 &&
						sameServedHeaders(served.headers, headers)
					) {
						// the forward gives it as it is; its body is not read here
						note.served.stored = served;
						return new Blob();
					}
					// its headers say something else now: its body, as a new response
					return await served.blob();
				}
				const kept = await rewrites.match(key);
				if (kept !== null) {
					note.rewriteCache = 'hit';
					return kept;
				}
				// as Response.text() decodes (a BOM goes, bad bytes are U+FFFD)
				const text = new TextDecoder().decode(bytes);
				const output = await rewriteScript(text, url, type, note);
				note.rewriteCache = 'miss';
				return output;
			},
			// a worker redirected stays in the partition it was started in
			(resource, url, kind) =>
				routeJS(
					resource,
					url,
					rewriter.config,
					type,
					kind ? workerKindPartition(kind) : '',
				),
			undefined,
			(headers, filteredHeaders) => {
				for (const header of integrityHeaders) {
					filteredHeaders.delete(header);
				}
			},
		);

	router.routes.set(/^\/js:generic\//, scriptTypeFactory('generic'));
	router.routes.set(
		/^\/js:genericModule\//,
		scriptTypeFactory('genericModule'),
	);
	router.routes.set(/^\/js:worker(:top:[^/]*)?\//, scriptTypeFactory('worker'));
	router.routes.set(
		/^\/js:workerModule(:top:[^/]*)?\//,
		scriptTypeFactory('workerModule'),
	);

	router.routes.set(
		/^\/css\//,
		genericForward(
			rewriter,
			async (url, response, _headers, _referrer, _request, note) => {
				if (!response.ok) return false;
				const text = await response.text();
				try {
					if (rewriter.config.rewriter !== 'wasm') return modifyCSS(text, url);
					// the module rewrites the sheet (waited for when this worker
					// has only just been handed it), and the request log says
					// whether it did or css-tree had to (a sheet with nothing to
					// route is looked into by neither)
					await scannerSettled();
					const told: StyleRewrittenBy = {};
					const output = modifyCSS(text, url, 'stylesheet', told);
					if (told.by) note.rewriteBy = told.by;
					return output;
				} catch (error) {
					// a stylesheet the parser rejects still reaches the page, its
					// url()s routed by the regex (as the CSSOM path does)
					console.warn(`Stomp could not parse ${url}: ${String(error)}`);
					return rewriteCSSValueURLs(text, url);
				}
			},
			(resource, url) => routeCSS(resource, url),
			undefined,
			(headers, filteredHeaders) => {
				for (const header of integrityHeaders) {
					filteredHeaders.delete(header);
				}
			},
		),
	);

	// an inline document (src/server/inline.ts): markup the page registered
	// under a single-use token, rewritten here like any fetched page and
	// served from this address, so the document is controlled and its
	// subresources reach this worker. An unknown, used or foreign token gets
	// the error page, never content.
	router.routes.set(
		/^\/inline:([A-Za-z0-9_-]{22})\//,
		async (request, path) => {
			const token = /^\/inline:([A-Za-z0-9_-]{22})\//.exec(path)![1];
			const entry = await takeInline(token, rewriter.directory);
			// the document's requests are judged by its origin (its creator's,
			// or an opaque one for a data: document), which this route's URL
			// does not name
			if (entry)
				try {
					recordInlineOrigin(
						request.url,
						new URL(entry.url).origin,
						partitionSite(entry.partition ?? ''),
					);
				} catch (error) {
					// not a URL: judged by its route
				}
			const headers: Record<string, string> = {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store',
			};
			if (!entry) {
				const message =
					'Stomp: this inline document is unknown, used or expired';
				return (
					(await hostErrorPage(rewriter, {
						url: request.url,
						status: 404,
						error: message,
						kind: 'routing',
					})) ??
					new Response(`<!doctype html><title>404</title><p>${message}</p>`, {
						status: 404,
						headers,
					})
				);
			}
			const url = new StompURL(
				entry.url,
				rewriter.codec,
				`${location.origin}${rewriter.directory}`,
			);
			// a document of a local scheme (about:, blob:, data:) inherits its
			// creator's referrer policy, which this navigation's request carries
			if (request.referrerPolicy)
				headers['referrer-policy'] = request.referrerPolicy;
			return new Response(
				modifyHTML(
					entry.markup,
					url,
					rewriter.config,
					true,
					undefined,
					undefined,
					undefined,
					undefined,
					false,
					undefined,
					shellSites(url),
				),
				{
					status: 200,
					headers,
				},
			);
		},
	);

	router.routes.set(
		/^\/html(:nested:[^/]*)?\//,
		genericForward(
			rewriter,
			async (url, response, responseHeaders, referrer, request, note) => {
				const contentType = responseHeaders.get('content-type');
				const mime = getMime(contentType || '');
				if (!htmlMimes.includes(mime)) return false;
				// decode the way the browser would have (BOM, header charset,
				// <meta charset>), then serve the rewritten document as UTF-8
				const bytes = new Uint8Array(await response.arrayBuffer());
				responseHeaders.set('content-type', utf8ContentType(contentType));
				// a proxied top (not a document a page routed as nested): its
				// shell loads the rewriter library
				const top =
					request.navigation &&
					nestedTopOf(new URL(request.routed).pathname, rewriter.directory) ===
						null;
				// an XML document (a standalone SVG, an XHTML page) keeps its mime
				// and gets an XML shell: the HTML one is not well-formed XML
				if (XML_DOCUMENT_MIMES.includes(mime))
					return modifyXML(
						decodeDocument(bytes, contentType),
						url,
						rewriter.config,
						mime,
						referrer,
						shellSites(url, request.routed, rewriter.directory),
						top,
					);
				// A Refresh header schedules its navigation on the document the
				// browser creates for this response, which the shell re-opens to
				// write the page: the re-open drops it. The same value as a meta
				// refresh in the markup lands in the written document instead, and
				// the inject routes it like any meta refresh the page wrote.
				let markup = decodeDocument(bytes, contentType);
				// a top-level page's Accept-CH and delegate-ch metas count from
				// its first subresource (the preload scanner's)
				if (request.navigation) {
					const hints = hintsDocument(request.clientId, request.routed);
					if (hints) applyMeta(hints, markup);
				}
				const refresh = response.headers.get('refresh');
				if (refresh !== null) {
					responseHeaders.delete('refresh');
					markup = withRefreshMeta(markup, refresh);
				}
				// the page's policy is stripped (it would refuse the proxy): an
				// upgrade-insecure-requests in it, its meta or its parent's is
				// applied by this worker to every request the document makes,
				// and by the inject to its WebSockets and beacons
				const upgradeInsecure =
					request.upgradeInsecure ||
					upgradesInsecureRequests(
						response.headers.get('content-security-policy'),
					) ||
					metaUpgradesInsecureRequests(markup);
				if (upgradeInsecure && request.navigation)
					rememberUpgradeInsecure(request.routed, request.clientId);
				// the blocker's side of the document (docs/adblock.md): the
				// lists' `$csp=` policies the proxy can enforce, beside its own,
				// and the cosmetic rules and scriptlets its inject applies
				const adblock = rewriter.blocker?.ready
					? rewriter.blocker.cosmetic(url.url.href, (script) =>
							modifyJS(script, url, rewriter.config, 'generic'),
						)
					: null;
				const listCsp = rewriter.blocker?.ready
					? rewriter.blocker.documentCsp(
							url.url.href,
							nestedTopOf(new URL(request.routed).pathname, rewriter.directory),
							`${new URL(request.routed).origin}${rewriter.directory}${SEALER_ROUTE}`,
						)
					: null;
				if (listCsp) responseHeaders.append('content-security-policy', listCsp);
				const job = prewrite(
					markup,
					url,
					mayKeep({
						method: request.method,
						requestHeaders: request.headers,
						status: response.status,
						responseHeaders: response.headers,
					})
						? request.partition
						: null,
				);
				if (!job)
					return modifyHTML(
						markup,
						url,
						rewriter.config,
						false,
						referrer,
						undefined,
						note.serviceWorker,
						null,
						upgradeInsecure,
						adblock,
						shellSites(url, request.routed, rewriter.directory),
						top,
						note.isolation,
						note.agentCluster,
					);
				// The page does not wait for the rewrite workers: the shell's
				// first part (the inject bundle's script and the markup) goes out
				// as soon as they have the scripts, and the browser loads and
				// runs the bundle while they rewrite (CNN's first visit waited
				// 1.9 s for its first byte). The part that hands the client the
				// markup and the table follows when the table is done; a table
				// that could not be made leaves every script to the client, as
				// with no worker.
				await job.dispatched;
				const { head, tail } = modifyHTMLStreamed(
					markup,
					url,
					rewriter.config,
					referrer,
					note.serviceWorker,
					upgradeInsecure,
					adblock,
					shellSites(url, request.routed, rewriter.directory),
					top,
					note.isolation,
					note.agentCluster,
				);
				const first = UTF8.encode(head);
				return new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(first);
						// after the response is on its way: the styles are
						// rewritten on this thread
						setTimeout(async () => {
							let table: Prewritten | null = null;
							try {
								table = await job.finish();
							} catch (error) {
								console.warn('Stomp: no prewritten table:', error);
							}
							try {
								controller.enqueue(UTF8.encode(tail(table)));
								controller.close();
							} catch (error) {
								// the page went away
							}
						});
					},
				});
			},
			// a nested document redirected stays nested, in its partition
			(resource, url, kind) =>
				routeHTML(
					resource,
					url,
					rewriter.config,
					false,
					(kind && nestedMarkOfKind(kind)) ?? false,
				),
			undefined,
			(headers, filteredHeaders, url) => {
				if (headers.has('x-frame-options')) {
					filteredHeaders.delete('x-frame-options');
				}

				// the worker keeps the site's client hints for its real origin
				// (clientHints.ts); the browser would keep them for the proxy
				// origin, every site's, and restart the shell for a Critical-CH
				filteredHeaders.delete('accept-ch');
				filteredHeaders.delete('critical-ch');

				// the page's own framing policy is gone (it would refuse our frame);
				// ours lets the host application embed the proxy origin, and the
				// proxy origin embed itself: a proxied page's iframes are proxied
				// pages too, and every ancestor has to match (YouTube's sign-in
				// frame was blocked without 'self')
				if (rewriter.config.frameAncestors?.length)
					filteredHeaders.set(
						'content-security-policy',
						`frame-ancestors 'self' ${rewriter.config.frameAncestors.join(' ')}`,
					);

				if (headers.has('refresh')) {
					filteredHeaders.set(
						'refresh',
						modifyRefresh(headers.get('refresh')!, url, rewriter.config),
					);
				}

				for (const header of integrityHeaders) {
					filteredHeaders.delete(header);
				}
			},
		),
	);

	router.routes.set(/^\/html:form(:nested:[^/]*)?\//, async (serverRequest) => {
		const oURL = new URL(serverRequest.url);
		const { url } = parseRoutedURL(
			`${oURL.origin}${oURL.pathname}${fragmentOf(oURL)}`, // exclude query
			rewriter.codec,
			`${oURL.origin}${rewriter.directory}`,
		);

		// a form without fields submits to `action?`, an empty query
		url.url = withQuery(url.url, queryOf(oURL));

		// a form an https page (or one under an https top) submits to http:
		// warned about, blocked in a nested frame, stopped at Chrome's
		// interstitial at the top; under upgrade-insecure-requests, upgraded
		// (src/mixedContent.ts)
		const nested = nestedTopOf(oURL.pathname, rewriter.directory);
		if (insecure(url.url)) {
			const referrer =
				serverRequest.referrer && serverRequest.referrer !== 'about:client'
					? serverRequest.referrer
					: null;
			let source: URL | null = null;
			try {
				if (referrer)
					source = parseRoutedURL(
						referrer,
						rewriter.codec,
						`${oURL.origin}${rewriter.directory}`,
					).url.url;
			} catch (error) {
				// not a routed page: nothing to judge it by
			}
			if (upgradesInsecure(undefined, referrer)) url.url = upgradedURL(url.url);
			else if (restrictsMixedContent(source) || restrictsMixedContent(nested)) {
				// Chrome warns for the form's action and for the URL it submits;
				// told before the answer, which unloads the page at the top
				const action = new URL(url.url.href);
				if (serverRequest.method === 'GET') action.search = '';
				await postNotices(
					[
						{ kind: 'form', url: action.href },
						{ kind: 'form', url: url.url.href },
						...(nested
							? [
									{
										kind: 'blocked' as const,
										type: 'form action',
										url: url.url.href,
									},
								]
							: []),
					],
					undefined,
					referrer,
				);
				if (nested) return new Response(null, { status: 204 });
				// the page writes them before it unloads for the interstitial
				await new Promise((resolve) => setTimeout(resolve, 100));
				return insecureFormPage(
					routeHTML(url, url, rewriter.config),
					serverRequest.method,
					await formFields(serverRequest),
					serverRequest.headers.get('content-type')?.split(';')[0] ||
						'application/x-www-form-urlencoded',
				);
			}
		}

		const target = routeHTML(
			url,
			url,
			rewriter.config,
			false,
			nestedMarkOf(oURL.pathname, rewriter.directory) ?? false,
		);
		// A GET form's navigation is a visit like a link's: it goes on
		// through the link route (src/visited.ts) of the URL the browser
		// built, in the context of the document that holds the form, which
		// the referrer names. The redirect here is the worker's own, like the
		// link route's (HOPS_MARKER)
		let location = target;
		if (serverRequest.method === 'GET')
			try {
				const from = new URL(serverRequest.referrer);
				if (
					from.origin === oURL.origin &&
					from.pathname.startsWith(rewriter.directory) &&
					/^html(:nested:[^/]*)?$/.test(
						from.pathname.slice(rewriter.directory.length).split('/')[0],
					)
				) {
					const source = parseRoutedURL(
						from.href,
						rewriter.codec,
						`${oURL.origin}${rewriter.directory}`,
					).url.url;
					const context = {
						frame: source.origin,
						top: siteOf(
							nestedTopOf(from.pathname, rewriter.directory) ?? source.origin,
							publicSuffix,
						),
					};
					location = linkRoute(
						`${oURL.origin}${rewriter.config.scope}`,
						rewriter.codec,
						contextText(context, publicSuffix),
						url.url,
					);
					rememberVisitedHop(location, {
						context,
						directory: rewriter.directory,
						nested: nestedMarkOf(oURL.pathname, rewriter.directory) ?? false,
						hops: 1,
					});
				}
			} catch (error) {
				// no referrer, or not a document of this controller: as before
			}
		return new Response(undefined, { headers: { location }, status: 307 });
	});

	registerServiceWorkerScripts(router, rewriter);

	// todo: parse more request headers
	router.routes.set(
		/^\/xhr\//,
		genericForward(rewriter, undefined, (resource) => routeBinary(resource)),
	);

	return {
		route,
		setRules(rules: RequestRule[]) {
			rewriter.rules = compileRules(rules);
			forgetRecentOutputs();
		},
		hostReloaded(mode: HostReload) {
			rewriter.hostReload = {
				mode,
				until: Date.now() + RESTORE_WINDOW_MS,
				loads: new Map(),
			};
		},
	};
}

/** the request headers that are STomp's own, never a page's */
const OWN_HEADERS = [
	ABORT_HEADER,
	LOAD_HEADER,
	OPAQUE_HEADER,
	CREDENTIALS_HEADER,
	PREFLIGHT_HEADER,
];

/**
 * A request's answer from the emulated service worker of the page that made
 * it (docs/service-workers.md), or null for the network: no registration
 * controls the page, the worker did not call respondWith, or it would not
 * start or answer in time. The worker sees the request as the page made it,
 * by its real URL; what it answers is then rewritten like the origin's
 * answer. A request the worker itself makes is never its own.
 */
async function answerFromServiceWorker<N extends Response>(
	rewriter: Rewriter,
	serverRequest: Request,
	url: StompURL,
	context: RouteContext | undefined,
	upload: Promise<Blob | undefined>,
	referrer: string,
	destination: string,
	startPreload: (value: string) => Promise<N>,
): Promise<{
	response: Response | null;
	control?: ControlInfo;
	/** the navigation preload's answer, for the page as the network's */
	network?: N;
}> {
	if (rewriter.config.serviceWorkers === false || context?.internal)
		return { response: null };
	// a navigation or a worker's script goes to the registration whose scope
	// its URL is in, and the document or worker it makes is controlled by it
	const nonSubresource =
		serverRequest.mode === 'navigate' ||
		serverRequest.destination === 'worker' ||
		serverRequest.destination === 'sharedworker';
	const clientId = nonSubresource
		? (context?.requestClientId ?? '')
		: (context?.requestClientId ?? context?.clientId);
	const routed = await serviceWorkers.route({
		url: url.url.href,
		nonSubresource,
		// the partition the document or worker it makes is in, from its route
		partition: nonSubresource
			? kindPartition(
					new URL(serverRequest.url).pathname
						.slice(rewriter.directory.length)
						.split('/')[0],
					url.url.origin,
					publicSuffix,
				)
			: undefined,
		clientId,
		resultingClientId: nonSubresource
			? (context?.resultingClientId ?? context?.clientId)
			: undefined,
	});
	const host = routed ? serviceWorkers.host(rewriter.directory) : undefined;
	if (!routed || !host) return { response: null };
	if (nonSubresource) {
		// the spec's soft update, once the navigation was answered; a worker
		// that waits for the page this one replaces goes on once that one is
		// gone
		const record = routed.record;
		const after = new Promise((resolve) => setTimeout(resolve, 1000))
			.then(() => serviceWorkers.softUpdate(record, host))
			.then(() => new Promise((resolve) => setTimeout(resolve, 1000)))
			.then(() => serviceWorkers.sweep());
		context?.waitUntil?.(after);
	}
	// navigation preload: a GET navigation's request goes out now, in
	// parallel with the worker's start, as the browser sends it
	const preload =
		serverRequest.mode === 'navigate' &&
		serverRequest.method === 'GET' &&
		routed.record.navigationPreload.enabled
			? startPreload(routed.record.navigationPreload.headerValue)
			: undefined;
	preload?.catch(() => {});
	let body: Blob | null;
	try {
		body = (await upload) ?? null;
	} catch (error) {
		// the page's body could not be read: as the network would have
		return { response: null, control: routed.control };
	}
	const answer = await serviceWorkers.dispatch(
		routed.record,
		host,
		{
			request: {
				url: url.url.href,
				method: serverRequest.method,
				headers: [...serverRequest.headers].filter(
					([name]) => !OWN_HEADERS.includes(name),
				),
				body,
				mode: serverRequest.mode,
				credentials: serverRequest.credentials,
				cache: serverRequest.cache,
				redirect: serverRequest.redirect,
				referrer,
				referrerPolicy: serverRequest.referrerPolicy,
				integrity: serverRequest.integrity,
				keepalive: serverRequest.keepalive,
				destination: destination as RequestDestination,
			},
			clientId: clientId ?? '',
			resultingClientId: nonSubresource
				? (context?.resultingClientId ?? context?.clientId ?? '')
				: '',
			isReload: !!context?.isReload,
		},
		preload,
	);
	if (answer !== null && 'network' in answer)
		return { response: null, control: routed.control, network: answer.network };
	return { response: answer, control: routed.control };
}

const SCRIPT_HEADERS = {
	'content-type': 'text/javascript; charset=utf-8',
	'cache-control': 'no-store',
};
const JS_MIME =
	/^(text|application)\/(x-)?(javascript|ecmascript)$|^text\/(jscript|livescript|javascript1\.[0-5])$/;

/**
 * The scripts of the pages' emulated service workers
 * (docs/service-workers.md): `sw:<version>/<url>` is a version's main
 * script, from storage, rewritten as a worker's with the preamble that makes
 * its global a service worker's; `swimport:<version>/<url>` is what it
 * imports, fetched and kept while it installs and served from storage after.
 * Only the controller's Worker gets the first and only the version's own
 * worker the second.
 */
function registerServiceWorkerScripts(router: Router, rewriter: Rewriter) {
	const refused = () =>
		new Response('Stomp: this route is not for this client', {
			status: 403,
			headers: { 'content-type': 'text/plain; charset=utf-8' },
		});
	const parse = (request: Request) =>
		parseRoutedURL(
			request.url,
			rewriter.codec,
			`${new URL(request.url).origin}${rewriter.directory}`,
		).url;

	router.routes.set(
		/^\/sw:([A-Za-z0-9_-]+)\//,
		async (request, path, context) => {
			if (rewriter.config.serviceWorkers === false)
				return new Response(null, { status: 404 });
			const version = /^\/sw:([A-Za-z0-9_-]+)\//.exec(path)![1];
			if (await serviceWorkers.isProxiedClient(context?.requestClientId))
				return refused();
			const found = await serviceWorkers.script(version);
			if (!found) return new Response(null, { status: 404 });
			serviceWorkers.markEmulated(context?.resultingClientId, version);
			const url = parse(request);
			const client = helperNames(rewriter.config).client;
			const script =
				modifyJS(
					found.script,
					url,
					rewriter.config,
					found.info.type === 'module' ? 'workerModule' : 'worker',
					`${client}.emulateServiceWorker(${JSON.stringify(found.info)});`,
				) + `\n;${client}.serviceWorkerEvaluated();`;
			return new Response(script, { headers: SCRIPT_HEADERS });
		},
	);

	router.routes.set(
		/^\/swimport:([A-Za-z0-9_-]+)\//,
		async (request, path, context) => {
			const version = /^\/swimport:([A-Za-z0-9_-]+)\//.exec(path)![1];
			const clientId = context?.requestClientId ?? context?.clientId;
			const client =
				clientId && typeof clients !== 'undefined'
					? await clients.get(clientId)
					: undefined;
			if (!serviceWorkers.isEmulated(clientId, client?.url, version))
				return refused();
			const url = parse(request);
			const real = url.url.href;
			const state = serviceWorkers.versionState(version);
			let text: string | null = null;
			if (state === 'parsed' || state === 'installing') {
				// what it imports now is kept for its later starts
				const response = await router.route(new Request(routeBinary(url)), {
					clientId,
					internal: true,
				});
				const mime = (response.headers.get('content-type') ?? '')
					.split(';')[0]
					.trim()
					.toLowerCase();
				if (!response.ok || !JS_MIME.test(mime)) return response;
				text = await response.text();
				await serviceWorkers.storeImport(version, real, text);
			} else if (state) text = await serviceWorkers.storedImport(version, real);
			// after install, a script it did not import then is a network error
			if (text === null) return Response.error();
			return new Response(modifyJS(text, url, rewriter.config, 'generic'), {
				headers: SCRIPT_HEADERS,
			});
		},
	);
}
