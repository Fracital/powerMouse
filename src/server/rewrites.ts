import {
	BareCompatibleClient,
	BareResponse,
	type ProxyTransport,
	type RawHeaders,
} from '@mercuryworkshop/proxy-transports';
import { acceptLanguage } from '../acceptLanguage';
import { FP_DEFAULT_ON_SURFACES, FP_SEEDED_SURFACES } from '../blocker/types';
import GenericCodec from '../Codecs';
import { codecType, Config, ParsedConfig } from '../config';
import {
	openerPolicy,
	realPolicy,
	switchesGroup,
	trustworthy,
	type OpenerFacts,
} from '../coop';
import {
	browserPolicy as browserContentPolicy,
	browserHeaders,
	parsePolicies,
	policyMark,
	policyNonce,
	REFUSED_URL,
	scriptFacts,
	WORKER_DIRECTIVES,
	type HopPolicy,
	type Policy,
	type ScriptFacts,
} from '../csp';
import type { DnrOutcome } from '../extensions/dnr';
import {
	displayExtensionURL,
	EXTENSION_INITIATOR,
	extensionOfHost,
} from '../extensions/origin';
import { CONTENT_SCRIPT_ROUTE, EXTENSION_API_ROUTE } from '../extensions/types';
import { freshFrameDocument } from '../freshFrame';
import { sourceKey } from '../functionSource';
import { rewriteLinkHeader } from '../headers';
import { helperNames } from '../helperNames';
import { modifyHTML, modifyHTMLStreamed } from '../htmlShell';
import { completeLength } from '../inject/dom/writeTokenizer';
import {
	byEngine,
	CHROMIUM,
	delegatedTo,
	documentIsolates,
	embedderPolicy,
	embedderPolicyBlocks,
	embedderRefuses,
	ISOLATION_PROBE,
	isolationFacts,
	isolationHeaders,
	isolationResponseHeaders,
	loadsPolicy,
	nestedIsolation,
	SERVED_EMBEDDER_POLICY,
	servedIsolationPolicy,
	topLevelIsolation,
	type DocumentIsolation,
	type EmbedderPolicy,
	type IsolationEngine,
	type IsolationPolicy,
} from '../isolation';
import { MARK_DIRECTIVES, MARKED_KINDS, OPAQUE_MARK } from '../memoryMark';
import {
	insecure,
	metaUpgradesInsecureRequests,
	mixedContentVerdict,
	potentiallyTrustworthy,
	restrictsMixedContent,
	upgradedURL,
	upgradesInsecureRequests,
} from '../mixedContent';
import { navigationAnswer } from '../navigationAnswer';
import {
	ephemeralKey,
	kindPartition,
	nestedMark,
	parseNestedMark,
	partitionSite,
	registrableDomain,
	siteOf,
	workerKindPartition,
	workerKindUnisolated,
} from '../partition';
import {
	handlerPreamble,
	handlerSources,
	hasBase,
	inlineSources,
	packRewrite,
	packStyle,
	scriptPreamble,
	type Prewritten,
} from '../prewrite';
import {
	DEFAULT_REFERRER_POLICY,
	refererFor,
	type ReferrerInfo,
} from '../referrerPolicy';
import { modifyRefresh } from '../refresh';
import {
	modifyCSS,
	rewriteCSSValueURLs,
	routeCSS,
	type StyleRewrittenBy,
} from '../rewriteCSS';
import {
	isXMLDocumentMime,
	nestedMarkOf,
	nestedMarkOfKind,
	nestedTopOf,
	routeHTML,
	setDocumentShells,
} from '../rewriteHTML';
import {
	modifyJS,
	RewrittenBy,
	routeJS,
	SCRIPT_FILE,
	ScriptType,
} from '../rewriteJS';
import {
	extensionsRuntimeJS,
	formQuery,
	linkRouteURL,
	parseRoutedURL,
	proxyBlobUUID,
	proxyOrigins,
	REFUSED_ROUTE,
	REFUSED_SOURCE_ROUTE,
	ROUTE_PROTOCOLS,
	routeBinary,
	setBlobRoute,
	unwrapRoute,
} from '../routeURL';
import { MODULE_PREFIX_ROUTE } from '../scriptRoutes';
import type { ControlInfo } from '../serviceWorkerTypes';
import { siteFacts, type SiteFacts } from '../siteFacts';
import {
	INTEGRITY_MARK,
	integrityMark,
	markIntegrity,
	NO_INTEGRITY,
	REFUSED_FRAGMENT,
	withIntegrityMark,
} from '../sri';
import { refusalBytes } from '../sriDigest';
import StompURL from '../StompURL';
import { getDomain, getPublicSuffix } from '../suffix';
import type {
	HostReload,
	IdentityReadMessage,
	RequestErrorKind,
	RequestInfo,
	RequestRule,
	RouteContext,
	SiteArrival,
} from '../transport/messages';
import {
	ABORT_HEADER,
	AWAY_MARKER,
	BLOB_ASK,
	CACHED_MARKER,
	CONNECTION_MARKER,
	CORS_MARKER,
	CREDENTIALS_HEADER,
	ENCODING_MARKER,
	FRESH_RETURN_ROUTE,
	HOPS_MARKER,
	IDENTITY_READ,
	IMAGES_WAITING,
	INITIATOR_ROUTE,
	JAR_MARKER,
	KEPT_MARKER,
	LOAD_HEADER,
	MARKUP_ROUTE,
	MEMORY_MARKER,
	NAVIGATION_STAYED,
	OPAQUE_COPY_HEADER,
	OPAQUE_HEADER,
	OPAQUE_MARKER,
	PREFLIGHT_HEADER,
	PROTOCOL_MARKER,
	RESPONSE_TYPE_HEADER,
	REVALIDATED_MARKER,
	SEALER_ROUTE,
	SIZE_MARKER,
	TAO_MARKER,
	TIMEOUT_HEADER,
	TIMING_DENIED_MARKER,
	TIMING_ONLY_MARKER,
	UNREPORTED_MARKER,
	WORKER_REPORT_LOAD,
	WORKER_SCRIPT_MARKER,
	XHR_MARKER,
} from '../transport/messages';
import { NETWORK_PARTITION } from '../transport/networkPartition';
import RemoteTransport from '../transport/RemoteTransport';
import {
	FIRST_IMAGES_URGENCY,
	queueValue,
	REQUEST_QUEUE,
	SEEN_URGENCY,
} from '../transport/requestQueue';
import {
	connectionMark,
	factsOf,
	notingFacts,
	type EncodedBytes,
	type ResponseFacts,
} from '../transport/responseFacts';
import { fragmentOf, queryOf, withQuery } from '../urlShape';
import { BUILD, REWRITE_GENERATION } from '../version';
import { contextText, isLinkRoute, LINK_SEGMENT, linkRoute } from '../visited';
import { rewriteBytesInWasm } from '../wasm/rewriteBytes';
import { scanMarkup, scannerSettled } from '../wasm/scanner';
import { modifyXML, xmlShellEncoding } from '../xmlShell';
import {
	anyApartClient,
	APART_AGENT_PATH,
	apartAgentResponse,
	rememberApartClient,
} from './apartAgent';
import { badPort } from './badPorts';
import {
	knownMinterOf,
	knownOriginOf,
	knownTopSiteOf,
	recordInlineOrigin,
} from './blobOrigins';
import { navigationUpstream, type BlockerLike } from './blocker';
import { BodyBytes } from './bodyBytes';
import {
	askedRange,
	byteRange,
	clearsCache,
	contentRange,
	FINISHED_LENGTH,
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
	splitForStore,
	wholeBodies,
	type CacheHit,
} from './cache';
import { cacheMarkOf, renewCacheSecret } from './cacheMarks';
import { calledClient, isCallPage } from './called';
import {
	decodeDocument,
	decodeScript,
	documentContentType,
	documentEncoding,
	encodeShell,
	scriptEncoding,
	stylesheetEncoding,
	utf8ContentType,
	xmlEncoding,
} from './charset';
import { clearSiteData, siteDataTypes } from './clearSiteData';
import {
	acceptedHints,
	applyClientHints,
	applyMeta,
	browserPolicy,
	criticalRetry,
	hintsDocument,
	persistAcceptCH,
	recordDocument as recordHintsDocument,
	syncXHRBlocked,
	topDocument,
	type HintsContext,
} from './clientHints';
import { holdRequest } from './clientRequests';
import {
	directiveOf,
	embeddingVerdict,
	hopRefusal,
	integrityPolicyDestinations,
	integrityRefuses,
	knowsPoliciesOf,
	metaPolicies,
	policiesGovern,
	postReport,
	refusesAncestors,
	refusingPolicies,
	rememberPolicies,
	rememberWorkerPolicies,
	responsePolicies,
	workerPolicies,
	workerReportAllowed,
} from './contentPolicies';
import Cookies, { changesTold, type JarCookie } from './Cookies';
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
import {
	headerLinesOf,
	splitHeaderLines,
	type DnrFlow,
	type DnrHost,
} from './dnr';
import {
	documentEncodingOf,
	rememberDocumentEncoding,
} from './documentEncodings';
import { embedderPolicyOf, rememberEmbedderPolicy } from './embedderPolicies';
import { DOCUMENT_DESTINATIONS, hostErrorPage } from './errorPage';
import { extensionApi } from './extensions/api';
import {
	contentScriptResponse,
	documentShell,
	type ExtensionShell,
	type ShellDocument,
} from './extensions/contentScripts';
import { fetchEvents, workerOf } from './extensions/fetchEvents';
import {
	ExtensionPipeline,
	type ExtensionRequest,
} from './extensions/pipeline';
import type { ExtensionRegistry } from './extensions/registry';
import { textDocumentBody, textDocumentKind } from './extensions/textDocument';
import { isStoreURL } from './extensions/webstore';
import {
	AdditionalFilter,
	browserBytes,
	filterNativeRequestHeaders,
	filterResponseHeaders,
	locationURL,
	REDIRECT_STATUSES,
	RouteTransform,
} from './filterHeaders';
import {
	chromeOrderedHeaders,
	queueUrgency,
	type RequestShape,
} from './headerOrder';
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
import { integrityHolds } from './integrity';
import { importMapIntegrity } from './integrityLoads';
import { noteKeptLoad } from './keptLoads';
import { takeLoadGrant, tellLoadClient } from './loadGrants';
import { recordCrossedMedia } from './mediaLoads';
import {
	awaitNavigationHint,
	awaitNavigationHintPeek,
	NavigationChain,
	navigationChain,
	NavigationHint,
	recordNavigationChain,
	recordNavigationHint,
	recordNavigationInitiator,
	takeNavigationHint,
	takeNavigationInitiator,
	type NavigationInitiator,
} from './navigationHints';
import {
	ORB_SNIFF_BYTES,
	orbByHeaders,
	orbMedia,
	orbSniff,
	peekBody,
} from './orb';
import type {
	ExtensionsServe,
	RemoteExtensions,
	ServedResponse,
} from './remoteExtensions';
import { queueReport, reportingEndpoints } from './reportUploads';
import { blobCreatorOf, creatorOf, requestOwner } from './requestClients';
import type { RewriteCache, RewriteCacheOutcome } from './rewriteCache';
import type { RewritePool } from './rewritePool';
import Router from './Router';
import { applyHeaderRule, CompiledRule, compileRules } from './rules';
import { nativeServiceWorker, serviceWorkers } from './serviceWorkers';
import type { ShieldsStore } from './shields';
import {
	firstBytes,
	nosniffType,
	saysNosniff,
	sniffDocument,
	unknownMime,
} from './sniff';
import { boundClient } from './srcdocVouches';
import type { StorageHosts } from './Storage';
import { syncAnswers } from './Sync';
import { learnSyncFrozen, syncFrozen, syncSeed } from './syncFrozen';
import { rememberVisitedHop, takeVisitedHop } from './visitedHops';

// What the rewrite cache keys its entries under for this build's rewriter: the
// generation (the rewriter's identity, stable across a deploy that did not
// touch it) when one is baked in, else the build (a dev build has no
// generation, and drops the cache on every activation anyway). A new rewriter
// is a new key, so its output never matches the last one's. Kept the same for
// the inline and the loaded-script paths.

// a data: document a route names gets its shell
setDocumentShells((name) => (name === 'modifyHTML' ? modifyHTML : modifyXML));
const CACHE_GENERATION = REWRITE_GENERATION || BUILD;

export const statusEmpty = [101, 204, 205, 304];

/**
 * The forward's responses whose body is a Blob: whole before they go out, so
 * the browser reads them and this worker writes nothing of them once handed
 * over (a navigation's need not last for its body, src/server/serviceWorker.ts).
 * WebKit refuses this worker reading such a Blob in a frame of another
 * site's page ("Blob loading failed"), and its body getter alone makes the
 * Blob a stream this worker reads: lasting asks for neither.
 */
export const blobResponses = new WeakSet<Response>();

const integrityHeaders: string[] = ['Content-MD5'];

declare const clients: Clients | undefined;

/** the real URL a request is reported as: without the `#url(...)` fragment the CSS rewriter keeps for idempotence */
function reportURL(url: StompURL): string {
	const text = url.toString();
	const marker = text.indexOf('#url(');
	return marker === -1 ? text : text.slice(0, marker);
}

/** the hostname of a real URL, '' when it is not a URL (for the shields key) */
function hostOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch (error) {
		return '';
	}
}

/** a URL, or null when the string is not one (for the shields key, computed per request) */
function urlOrNull(value: string): URL | null {
	try {
		return new URL(value);
	} catch (error) {
		return null;
	}
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
	'sec-fetch-storage-access',
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
	 * a hop of the chain was of another origin and its Timing-Allow-Origin
	 * did not name the initiator: the load's resource timing is restricted
	 * whatever its last hop allows (the timing allow check fails for good)
	 */
	timingDenied?: boolean;
	/**
	 * the chain is a load the inject copies for a page, under a grant its
	 * first hop took (loadGrants.ts): the browser repeats the token on every
	 * hop, and a hop that carries the same one is the same load
	 */
	grant?: { token: string; load: string };
	/** the routed URL the chain began at */
	first?: string;
	/**
	 * the chain went from one origin to another: the Authorization header
	 * the page set stays behind from here on (the browser follows the chain
	 * in proxy URL space, where it never crosses, and sends it on every hop)
	 */
	unauthorized?: boolean;
	/**
	 * the hosts whose Set-Cookie on a hop so far changed the jar, which the
	 * chain's answer names to the inject (JAR_MARKER); the hop's own list,
	 * filled once its cookies are stored, before the browser asks for the next
	 */
	jar?: string[];
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
	// a FedCM endpoint (config, accounts, client metadata, token, disconnect),
	// which the Credentials inject fetches through the proxy in the browser's
	// place; the destination makes Sec-Fetch-Dest: webidentity go to the IdP
	// (src/inject/dom/modules/Credentials.ts)
	'webidentity',
	// a violation's report to the page's policy's report-uri, which the
	// inject sends in the browser's place (src/inject/dom/violationDelivery.ts)
	'report',
	// and one to its report-to endpoint, which the inject hands to this
	// worker to deliver (reportUploads.ts): never forwarded as it is
	'reports',
];
// (`same-origin`: an SVG <use>'s external document, which Chrome loads as
// an image of the document's own origin only)
const LOAD_MODES = ['no-cors', 'cors', 'same-origin'];
/**
 * A CORS load of these that an element or a stylesheet starts carries
 * Origin to its own origin too, where a fetch's does not: a crossorigin
 * image, script and stylesheet, a module script, a font (and a crossorigin
 * video does not; measured in Chrome 157, blank-load-metadata)
 */
const ORIGIN_ALWAYS = ['image', 'script', 'style', 'font'];
/** the longest FedCM endpoint body the worker reads for the inject (identityRead) */
const IDENTITY_READ_MAX = 1 << 20;
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
 * A worker's report to its own policy's report-uri, which its inject sends
 * in the browser's place (src/inject/worker/Client.ts deliverReport; a
 * worker has no load channel): the `report no-cors` load where the
 * requesting worker's policy names the endpoint (`endpoint`, the
 * request's real URL) and the body is a report of that policy
 * (contentPolicies.ts workerReportAllowed), else null
 */
async function workerReportLoad(
	request: Request,
	header: string | null,
	context: RouteContext | undefined,
	endpoint: URL,
): Promise<string | null> {
	const client = context?.clientId;
	if (header !== WORKER_REPORT_LOAD || request.method !== 'POST' || !client)
		return null;
	// (a blob: worker is known by its creator once one of its requests was
	// looked up)
	if (!knowsPoliciesOf(client)) await requestOwner(client);
	return workerReportAllowed(
		client,
		endpoint,
		await request.clone().text(),
		blobCreatorOf,
	)
		? 'report no-cors'
		: null;
}

/**
 * Chrome's name for a request whose destination does not say what it is
 * (src/mixedContentNotices.ts typeName): an XMLHttpRequest (the inject marks its
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
 * browsing context (FRESH_RETURN_ROUTE): `referrer` (the document's routed
 * URL) is its referrer, under `policy`, the document's own for it
 */
function rememberFreshReturn(
	url: string,
	referrer: string,
	policy: ReferrerPolicy,
) {
	rememberReturn(url, { referrer, policy, url, fresh: true });
}

function takeReturn(url: string) {
	const entry = returns.get(url);
	if (!entry) return undefined;
	returns.delete(url);
	return Date.now() - entry.at > REDIRECT_HOP_TTL ? undefined : entry;
}

/**
 * The site pool (src/controller/sitePool.ts): a navigation this worker
 * sends on to another slot's worker takes with it what this worker knew of it: the
 * referrer and policy it came back with (rememberReturn), the redirect
 * chain it is a hop of, and the hint of the document that started it (the
 * first hop of a chain only). Taken here, so nothing of it is left behind.
 * And what the documents of the navigation told of the page policies that
 * judge its later hops and the frame's ancestors (navigationChain), which
 * stays here too: a chain may come back. `realOf`: the real URL of a route
 * of this worker's, or null. A later hop of a chain is judged here, by the
 * policies its documents told this worker (whose clients it can tell of a
 * report-only refusal): `refused` is where a refused one goes instead
 * (hopRefusal), and the next slot's worker does not judge it again.
 * `frame`: the navigation is a frame's (its route is a nested one).
 */
export async function siteDeparture(
	request: Request,
	real: string,
	hintWait: number,
	realOf: (routed: string) => string | null = () => null,
	frame = false,
): Promise<Omit<SiteArrival, 'path'> & { refused?: string }> {
	const returned = takeReturn(request.url);
	// a document that started a navigation of another window made from that
	// window's realm (INITIATOR_ROUTE) is its initiator there too
	const initiated = takeNavigationInitiator(real);
	const referrer = returned
		? returned.referrer
		: request.referrer && request.referrer !== 'about:client'
			? request.referrer
			: '';
	const policy = returned?.policy ?? request.referrerPolicy;
	const hop = takeRedirect('', referrer, returned?.url ?? request.url);
	const own = `${new URL(request.url).origin}/`;
	const hint =
		takeNavigationHint(real) ??
		(referrer || hop ? null : await awaitNavigationHint(real, hintWait));
	// (kept by the real URL the chain began at, as genericForward looks it up)
	const start = (hop?.first && realOf(hop.first)) || real;
	const known = navigationChain(start);
	if (known && hop) {
		let url: URL | null = null;
		try {
			url = new URL(real);
		} catch (error) {
			// not a URL: nothing to judge
		}
		const refused = url && hopRefusal(known, url, frame, start);
		if (refused) return { refused };
	}
	const chain: SiteArrival['chain'] = known
		? {
				start,
				policies: known.policies.map(({ policy, parent }) => [policy, parent]),
				...(known.ancestors ? { ancestors: known.ancestors } : {}),
				...(known.required !== undefined ? { required: known.required } : {}),
				...(known.coop ? { coop: known.coop } : {}),
				...(hop ? { judged: true } : {}),
			}
		: undefined;
	return {
		...(referrer.startsWith(own)
			? { referrer: referrer.slice(own.length - 1) }
			: {}),
		...(policy ? { policy } : {}),
		...(hint ? { hint } : {}),
		...(hop ? { hop } : {}),
		...(chain ? { chain } : {}),
		...(initiated
			? {
					initiator: {
						...initiated,
						referrer: initiated.referrer.startsWith(own)
							? initiated.referrer.slice(own.length - 1)
							: '',
					},
				}
			: {}),
	};
}

/**
 * The site pool: the routed URLs of hops another slot's worker judged
 * before it sent them here (siteDeparture), each judged no more here
 */
const judgedArrivals = new Set<string>();

/** a hop policy as navigationHints keeps it (HopPolicy) */
function isHopPolicy(policy: unknown): policy is HopPolicy {
	return (
		Array.isArray(policy) &&
		typeof policy[0] === 'string' &&
		Array.isArray(policy[1]) &&
		policy[1].every((source) => typeof source === 'string') &&
		(policy[2] === 'enforce' || policy[2] === 'report') &&
		typeof policy[3] === 'string'
	);
}

/**
 * The site pool: a navigation another slot's worker sent here, put where
 * this worker looks for what it knew of a navigation, as if it had begun
 * here: its referrer (the routed path, on this origin), its policy, its hint
 * and its redirect chain
 */
export function siteArrived(
	request: Request,
	real: string,
	arrival: SiteArrival,
) {
	const origin = new URL(request.url).origin;
	const referrer = arrival.referrer ? `${origin}${arrival.referrer}` : '';
	rememberReturn(request.url, {
		referrer,
		policy: (arrival.policy || DEFAULT_REFERRER_POLICY) as ReferrerPolicy,
		url: request.url,
	});
	if (arrival.hop && typeof arrival.hop === 'object') {
		const hop = { ...(arrival.hop as RedirectHop) };
		// the chain's first URL, a route of the slot it began on: the same
		// route on this origin, which this worker can read
		if (typeof hop.first === 'string')
			try {
				const first = new URL(hop.first);
				hop.first = `${origin}${first.pathname}${first.search}${first.hash}`;
			} catch (error) {
				delete hop.first;
			}
		rememberRedirect('', referrer, request.url, request.url, hop);
	}
	if (arrival.hint && typeof arrival.hint === 'object')
		recordNavigationHint(real, arrival.hint as NavigationHint);
	// (its routed path on this origin, as the referrer's)
	const initiator = arrival.initiator as
		Partial<NavigationInitiator> | undefined;
	if (
		typeof initiator?.referrer === 'string' &&
		typeof initiator.policy === 'string' &&
		typeof initiator.origin === 'string'
	)
		recordNavigationInitiator(real, {
			referrer: initiator.referrer.startsWith('/')
				? `${origin}${initiator.referrer}`
				: '',
			policy: initiator.policy,
			origin: initiator.origin,
			activated: initiator.activated === true,
		});
	// the page policies that judge the chain's later hops and the frame's
	// real ancestors, as the documents that started it told the first slot
	const chain = arrival.chain;
	if (
		chain &&
		typeof chain.start === 'string' &&
		Array.isArray(chain.policies)
	) {
		const ancestors =
			Array.isArray(chain.ancestors) &&
			chain.ancestors.every((origin) => typeof origin === 'string')
				? chain.ancestors
				: undefined;
		const told = chain.policies.filter(
			(entry): entry is [HopPolicy, boolean] =>
				Array.isArray(entry) && isHopPolicy(entry[0]),
		);
		const required =
			typeof chain.required === 'string' && chain.required.length <= 4096
				? chain.required
				: undefined;
		const coop = chain.coop;
		const facts =
			Array.isArray(coop) &&
			coop.length === 4 &&
			typeof coop[0] === 'boolean' &&
			coop
				.slice(1)
				.every((part) => typeof part === 'string' && part.length <= 2048)
				? (coop as OpenerFacts)
				: undefined;
		if (chain.judged === true) {
			judgedArrivals.add(request.url);
			if (judgedArrivals.size > 256)
				judgedArrivals.delete(judgedArrivals.values().next().value!);
		}
		for (const parent of [false, true]) {
			const policies = told
				.filter((entry) => (entry[1] === true) === parent)
				.map(([policy]) => policy);
			if (policies.length || (!parent && (ancestors || facts)))
				recordNavigationChain(
					chain.start,
					policies,
					ancestors,
					undefined,
					parent,
					parent ? undefined : required,
					parent ? undefined : facts,
				);
		}
	}
}

/**
 * The site pool: a frame's navigation that leaves for another slot, judged
 * for mixed content here first, as the route below judges it: the parent
 * that asked for it (at `referrer`) is this worker's client, which hears
 * the console notices, and whose upgrade-insecure-requests this worker
 * knows. A Response when the navigation is blocked (no document commits)
 * or upgraded (its https route, which may well be this slot's), null when
 * it goes on. `top`: the main frame's origin (a nested route's); a
 * top-level navigation is never mixed content.
 */
export function departingMixedContent(
	request: Request,
	referrer: string | null,
	top: string | null,
	rewriter: { directory: string; codec: GenericCodec; shields?: ShieldsStore },
): Response | null {
	if (top === null) return null;
	const oURL = new URL(request.url);
	const prefix = `${oURL.origin}${rewriter.directory}`;
	let routed: ReturnType<typeof parseRoutedURL>;
	try {
		routed = parseRoutedURL(request.url, rewriter.codec, prefix);
	} catch (error) {
		return null;
	}
	const { url, resource } = routed;
	let context: URL | null = null;
	if (referrer)
		try {
			context = parseRoutedURL(referrer, rewriter.codec, prefix).url.url;
		} catch (error) {
			// not a routed page: judged by the top alone
		}
	const source = context?.href ?? urlOrNull(top)?.href ?? '';
	const verdict = mixedContentVerdict({
		url: new URL(reportURL(url)),
		destination: request.destination || 'empty',
		imageSet: false,
		type: requestTypeOf(request),
		context,
		top,
		upgradeInsecure:
			upgradesInsecure(undefined, null, referrer) ||
			!!rewriter.shields?.httpsUpgrade(hostOf(source || reportURL(url))),
	});
	postNotices(verdict.notices, undefined, referrer);
	if (verdict.action === 'block') return new Response(null, { status: 204 });
	if (verdict.action === 'upgrade')
		return new Response(null, {
			status: 307,
			headers: {
				location: `${prefix}${resource}/${new StompURL(verdict.url, url).encode()}`,
				'cache-control': 'no-store',
			},
		});
	return null;
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
	const to = location === null ? null : locationURL(location, from.url);
	return to !== null && to.origin !== from.url.origin;
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
		/** a frame's navigation: the real origins of the frame's ancestors, nearest first */
		ancestors?: string[] | null;
		/** a frame's navigation: the policy its csp attribute requires (navigationHints) */
		requiredCSP?: string | null;
		/**
		 * a top-level navigation's: whether it is a top-level window's (a
		 * popup's, which the browser sees as top-level), and what the
		 * documents that started it told of its opener policy (src/coop.ts)
		 */
		opener?: { window: boolean; facts: OpenerFacts | null } | null;
		/** the request's destination and mode (a worker's own script is `same-origin`, what it imports `cors`) */
		destination?: RequestDestination;
		mode?: RequestMode;
		/** the client a worker's own script makes (the worker) */
		resultingClientId?: string;
		/**
		 * a frame's navigation: its parent's frame-src, as the documents that
		 * navigated it told it (NavigationChain), when they did
		 */
		framePolicies?: HopPolicy[] | null;
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
	/** the document's isolation, when the host's page is isolated or `apart` (src/isolation.ts isolationFacts) */
	isolation?: string;
	/** the Document-Isolation-Policy of the proxy's own the document is served with, under a host that is not isolated */
	apart?: IsolationPolicy;
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
	/** how many bytes the origin's body was, when the transform read it (SIZE_MARKER) */
	bytes?: number;
	/** the document is a hard reload's (hardLoads): its shell says so (Config hardLoad) */
	hardLoad?: boolean;
	/**
	 * how many bytes the origin's body came as before the transport decoded
	 * its Content-Encoding, once the body has ended (responseFacts.ts)
	 */
	encodedBytes?: EncodedBytes;
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
	blocker?: BlockerLike;
	/** the scope's extensions (docs/extensions.md) */
	extensions?: ExtensionRegistry;
	/** a slot of the site pool: the hub's worker's extensions, which its documents' content scripts are (./remoteExtensions.ts) */
	remoteExtensions?: RemoteExtensions;
	/** what the request path asks of them */
	pipeline?: ExtensionPipeline;
	/** the host asked for the blocker: the first navigation waits for its lists (on by default, for the snapshot alone) */
	blockerAsked?: boolean;
	/** the per-site shields the controller set (src/server/shields.ts) */
	shields?: ShieldsStore;
	/** the extensions' declarativeNetRequest rules (src/server/dnr.ts) */
	dnr?: DnrHost;
	/** the scope's localStorage and sessionStorage (Clear-Site-Data) */
	storage?: StorageHosts;
	/**
	 * the host page was reloaded (src/controller/hostReload.ts): the cache
	 * mode the pages it restores take, and until when a navigation counts
	 * as one
	 */
	hostReload?: { mode: HostReload; until: number };
	/**
	 * the routed URLs (no fragment) of documents a frame reloads past the
	 * caches (Frame.reload's `bypassCache`), with until when each counts:
	 * the next navigation to one is that hard reload
	 */
	hardReloads?: Map<string, number>;
	/**
	 * the routed URLs (no fragment) of history steps the controller takes
	 * with location.replace (src/controller/history.ts), with until when
	 * each counts: the next navigation to one is the step, and takes the
	 * kept document as a traversal does
	 */
	historySteps?: Map<string, number>;
	/** the host's page is cross-origin isolated (config.isolated) */
	isolated: boolean;
	/**
	 * what the browser makes of cross-origin isolation where engines differ
	 * (src/isolation.ts byEngine), asked of the controller's document once
	 * and kept; Chrome's rules when it cannot say
	 */
	isolationEngine: () => Promise<IsolationEngine>;
	/**
	 * a top-level page that is isolated natively is shown to the client
	 * `client` without isolation (a host that is not isolated, in a browser
	 * without Document-Isolation-Policy): the controller says so in its
	 * navigate event (NavigateInfo.isolation), so the host may offer it a
	 * window of its own
	 */
	isolationWanted?: (client: string) => void;
	/**
	 * a document is served with the proxy's Document-Isolation-Policy: the
	 * controller starts the agent of such documents only once one was
	 * (src/controller/apart.ts)
	 */
	apartServed?: () => void;
}

/** how long a decision waits for the controller to say what the browser makes of isolation (then Chrome's rules) */
const ISOLATION_ENGINE_WAIT_MS = 3000;

/** how long after a reloaded host's word a top-level navigation is one it restores */
const RESTORE_WINDOW_MS = 10_000;
/** how long after the controller's word a navigation to its URL is the history step it told of */
const HISTORY_STEP_MS = 10_000;
/**
 * how long what a hard-reloaded document loads goes past the caches at
 * most: natively until its load event is over, which the document tells
 * (HARD_LOADED, hardLoadEnded); this bounds a document that never says
 */
const HARD_LOAD_MS = 30_000;

/**
 * The documents a hard reload made (the host's restored page, a frame's
 * document, the frames each made as it loaded), by client id: their routed
 * URL (no fragment), and until when each loads past the caches
 */
const hardLoads = new Map<string, { url: string; until: number }>();

/** `client`, a document at `url` a hard reload made, loads past the caches from `now` on */
function hardLoad(client: string, url: string, now: number) {
	for (const [kept, load] of hardLoads)
		if (load.until <= now) hardLoads.delete(kept);
	hardLoads.set(client, { url: url.split('#')[0], until: now + HARD_LOAD_MS });
}

/** the load event of `client`, a document a hard reload made, is over: what it loads from now on takes the caches */
export function hardLoadEnded(client: string) {
	hardLoads.delete(client);
}

/** whether a frame's document at `referrer` is still loading as a hard reload's */
function hardLoading(referrer: string, now: number) {
	if (!referrer) return false;
	const url = referrer.split('#')[0];
	for (const load of hardLoads.values())
		if (load.url === url && load.until > now) return true;
	return false;
}

/** an extension cancelled the request: to the page a network error, as Chrome's ERR_BLOCKED_BY_CLIENT */
function extensionRefusal(): Error {
	return Object.assign(new Error('blocked by an extension'), {
		stompReported: true,
	});
}

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
			const top = nestedTopOf(new URL(routed).pathname, directory, url.codec);
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

/** what this worker knows of a request's service worker client */
interface ClientFacts {
	/** its real URL (an origin is all a request reads of it) */
	client: URL | null;
	/** its routed URL, when it is a routed document or worker */
	clientRoute: string | null;
	/**
	 * a blob: worker whose minting page this worker does not know (it
	 * restarted since, which empties what it was told, or the blob was
	 * minted inside a worker): judged as another site, never as the
	 * target's own, so it gets no same-origin credentials or Strict cookies
	 */
	unknownBlob: boolean;
	/**
	 * a client whose URL names no origin this worker can read (an
	 * about:srcdoc document): judged by its Referer, else as an opaque one
	 */
	unknownClient: boolean;
	/**
	 * the top-level site of a partitioned blob: worker or inline document,
	 * which its URL does not name (its creator's, as the worker recorded it)
	 */
	clientTopSite: string | null;
}
const NO_CLIENT: ClientFacts = {
	client: null,
	clientRoute: null,
	unknownBlob: false,
	unknownClient: false,
	clientTopSite: null,
};

/**
 * What the worker knows of client `id`, kept per client once known. `wait`:
 * an about:srcdoc document that has not claimed its ancestor yet is waited
 * for a little (when no Referer says whose the request is)
 */
async function clientFacts(
	id: string,
	decode: (routed: string) => URL | null,
	routedPrefix: string,
	wait: boolean,
): Promise<ClientFacts> {
	if (typeof clients === 'undefined') return NO_CLIENT;
	let client = clientURLs.get(id) ?? null;
	let clientRoute = clientRoutes.get(id) ?? null;
	let clientTopSite = clientTopSites.get(id) ?? null;
	let unknownBlob = false;
	let unknownClient = false;
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
			// reports the client's URL as empty until it has parsed); and a
			// call page's written document (./called.ts), by its call
			if (
				!client &&
				found &&
				found.type === 'window' &&
				(found.url === '' ||
					found.url.startsWith('about:srcdoc') ||
					isCallPage(found.url))
			) {
				const bound = await boundClient(id, wait);
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
	return { client, clientRoute, unknownBlob, unknownClient, clientTopSite };
}

/**
 * The top-level site of service worker client `id` of the controller at
 * `directory`, as a subresource request of the client finds it (the
 * route's `topSite`, without a Referer), or null when the worker cannot
 * tell. A socket never passes this worker: the controller names the
 * client that opens it, and its party is judged by this site, as a
 * request's is.
 */
export async function clientTopSiteOf(
	id: string,
	directory: string,
	codec: GenericCodec,
): Promise<string | null> {
	const routedPrefix = `${location.origin}${directory}`;
	const { client, clientRoute, clientTopSite } = await clientFacts(
		id,
		(routed) => {
			try {
				return parseRoutedURL(routed, codec, routedPrefix).url.url;
			} catch (error) {
				return null;
			}
		},
		routedPrefix,
		true,
	);
	return (
		clientTopSite ??
		(clientRoute ? routeTopSite(clientRoute, directory, codec) : null) ??
		(client && client.origin !== 'null' ? siteOf(client, publicSuffix) : null)
	);
}

/**
 * The top-level site a routed URL's kind names: a nested document's (its
 * top origin's site), a partitioned worker's; null for any other
 */
function routeTopSite(
	routed: string,
	directory: string,
	codec: GenericCodec,
): string | null {
	let pathname: string;
	try {
		pathname = new URL(routed).pathname;
	} catch (error) {
		return null;
	}
	const nested = nestedTopOf(pathname, directory, codec);
	if (nested) return siteOf(nested, publicSuffix);
	if (!pathname.startsWith(directory)) return null;
	const kind = pathname.slice(directory.length).split('/')[0];
	// an emulated service worker's is its registration's
	if (kind.startsWith('sw:'))
		return partitionSite(serviceWorkers.versionPartition(kind.slice(3)));
	return partitionSite(workerKindPartition(kind, codec));
}

/** the partition of a client of `origin` at a routed URL, from its route kind (src/partition.ts) */
function routePartition(
	routed: string,
	directory: string,
	origin: string,
	codec: GenericCodec,
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
	return kindPartition(kind, origin, publicSuffix, codec);
}

/** requests in flight the page may still abort, by the id it sent (ABORT_HEADER) */
const pendingAborts = new Map<string, () => void>();
/** how to give up each request in flight, for one whose client goes (clientRequests.ts) */
const requestAborts = new WeakMap<Request, () => void>();
/** the page posted that it aborted the request with this id */
export function abortRequest(id: unknown) {
	if (typeof id === 'string') pendingAborts.get(id)?.();
}

/**
 * navigations waiting for their answer, by the routed URL the browser asked
 * for (no fragment): how to stop each, for the host's Stop (stopNavigation)
 */
const navigationStops = new Map<string, Set<() => void>>();
/** a routed URL as a navigation's request names it: without its fragment */
const withoutFragment = (url: string) => {
	const hash = url.indexOf('#');
	return hash === -1 ? url : url.slice(0, hash);
};
/**
 * stops that came before their navigation's request did, by routed URL:
 * until when the request is answered with a 204 without being made
 */
const earlyStops = new Map<string, number>();
/** how long a stop waits for its navigation's request (the frame's src was set a moment before; EARLY_STOP_MS in src/controller/index.ts) */
const EARLY_STOP_MS = 2000;
/**
 * The host stopped the frame it sent to `routed` (Frame.stop): a navigation
 * to it still waiting for its answer is given up, and answered with a 204,
 * for which the browser commits nothing (the frame keeps the document it
 * has, as after Chrome's Stop). One answered already is the document's
 * load, which the frame's own stop ends. `early`: the browser goes on with
 * the navigation whatever the frame's document does (the host set the src
 * of a frame of another origin), so one whose request has not come yet is
 * answered so when it comes, within EARLY_STOP_MS
 */
export function stopNavigation(routed: unknown, early = false) {
	if (typeof routed !== 'string') return;
	const url = withoutFragment(routed);
	const stops = navigationStops.get(url);
	if (stops) for (const stop of [...stops]) stop();
	else if (early) earlyStops.set(url, Date.now() + EARLY_STOP_MS);
}
/** the host sends a frame to `routed` again: an early stop of it is over */
export function navigationSent(routed: unknown) {
	if (typeof routed === 'string') earlyStops.delete(withoutFragment(routed));
}

/**
 * the document that told the worker it starts a navigation (its hint), by
 * the navigation's request: the one the frame leaves, told when the answer
 * leaves it where it is (NAVIGATION_STAYED)
 */
const leavingClients = new WeakMap<Request, string>();
/** who hears of a navigation answered with no document (the worker's controllers: setNavigationStayed) */
let navigationStayedListener: ((routed: string) => void) | null = null;
/** what the worker does with a navigation answered with no document (src/server/serviceWorker.ts) */
export function setNavigationStayed(listener: (routed: string) => void) {
	navigationStayedListener = listener;
}
/**
 * A navigation to `routed` was answered with no document (a 204, a
 * download: navigationAnswer), so the browser commits none and the frame's
 * load is over: the host hears of it (a frame it sent there, Frame's
 * `stayed`), and so does the document that started it, which tells its
 * host the same
 */
function navigationStayed(request: Request) {
	navigationStayedListener?.(request.url);
	const leaving = leavingClients.get(request);
	if (leaving) tellLoadClient(leaving, NAVIGATION_STAYED);
}

/** this worker's names for its requests in the transport's queue (REQUEST_QUEUE) */
const QUEUE_PREFIX = Math.random().toString(36).slice(2, 10);
let queueCount = 0;
/** by its URL (the routed one the browser asked the worker for), how to raise each image request not yet answered */
const unansweredImages = new Map<string, Set<() => void>>();
/**
 * the images pages laid out in their viewports lately, by URL, and when:
 * the page tells as soon as it has laid them out, which can be before
 * their requests reach this worker, and those go out raised
 */
const seenImages = new Map<string, number>();
const SEEN_KEPT = 1024;
const SEEN_MS = 30_000;
const seenLately = (url: string) =>
	(seenImages.get(url) ?? -Infinity) > performance.now() - SEEN_MS;

/**
 * Chrome gives a document's first five images a script's urgency until it
 * has laid them out (measured in Chrome 157: Priority u=2, i over HTTP/2,
 * and their place in the line for a connection to an HTTP/1 server): the
 * image requests each client has made, by client, the oldest dropped first
 */
const imagesMade = new Map<string, number>();
const FIRST_IMAGES = 5;
const CLIENTS_KEPT = 1024;
/** whether the image request this client makes now is one of its first five */
function firstImage(client: string | undefined): boolean {
	if (!client) return false;
	const made = imagesMade.get(client) ?? 0;
	if (made >= FIRST_IMAGES) return false;
	imagesMade.delete(client);
	if (imagesMade.size >= CLIENTS_KEPT)
		imagesMade.delete(imagesMade.keys().next().value!);
	imagesMade.set(client, made + 1);
	return true;
}

/** what the worker noted of a request as its fetch event came (noteRequest) */
interface RequestNote {
	/** when (ms since the epoch) */
	askedAt: number;
	/** an image request among its client's first five */
	first: boolean;
}
const requestNotes = new WeakMap<Request, RequestNote>();

/**
 * Note `request` as its fetch event comes, before any of the worker's work
 * on it: the order the browser asked in is the order requests of one
 * urgency leave in (REQUEST_QUEUE), and a document's first five images are
 * the first five it asked for, whatever order the work on each finishes in
 */
export function noteRequest(request: Request, client: string) {
	requestNotes.set(request, {
		askedAt: performance.timeOrigin + performance.now(),
		first:
			request.destination === 'image' &&
			request.mode !== 'navigate' &&
			firstImage(client),
	});
}

/**
 * The client of each image request not answered yet, by its name in the
 * transport's queue, and the clients told one of theirs waits
 * (IMAGES_WAITING): a document watches its images only once told, so a
 * frame whose images never wait (an ad's pixel, every image of an HTTP/2
 * site) pays nothing for it
 */
const imageClients = new Map<string, string>();
const toldClients = new Set<string>();
RemoteTransport.waiting = (id) => {
	const client = imageClients.get(id);
	if (client === undefined || toldClients.has(client)) return;
	if (!tellLoadClient(client, IMAGES_WAITING)) return;
	if (toldClients.size >= CLIENTS_KEPT) toldClients.clear();
	toldClients.add(client);
};

/**
 * A page laid these images (their URLs as the browser's own src getter
 * reads them: the routed ones, the requests' own) out in its
 * viewport while they loaded (IMAGES_SEEN): each request for one still
 * waiting for a connection waits at a fetch's urgency from now on, as
 * Chrome raises it, and so does one that has not reached the worker yet
 */
export function imagesSeen(urls: unknown) {
	if (!Array.isArray(urls)) return;
	const now = performance.now();
	for (let url of urls) {
		if (typeof url !== 'string') continue;
		const hash = url.indexOf('#');
		if (hash !== -1) url = url.slice(0, hash);
		seenImages.delete(url);
		if (seenImages.size >= SEEN_KEPT)
			seenImages.delete(seenImages.keys().next().value!);
		seenImages.set(url, now);
		for (const raise of unansweredImages.get(url) ?? []) raise();
	}
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
		// when the browser asked: the transport's queue keeps that order
		const noted = requestNotes.get(serverRequest);
		const askedAt =
			noted?.askedAt ?? performance.timeOrigin + performance.now();
		// the page's abort reaches the worker as a message under the id the
		// page put in the request (Chrome does not fire the request's own
		// signal in a fetch event); the signal is honoured too where it fires
		const signal = (serverRequest as { signal?: AbortSignal }).signal;
		const abortId = serverRequest.headers.get(ABORT_HEADER);
		// whether the page gave the request up, by either way: an answer
		// that arrives after it is cancelled, or the transport goes on
		// receiving a body nobody will read
		let aborted = false;
		const abortedSoon = new Promise<never>((_, reject) => {
			const abort = () => {
				aborted = true;
				reject(ABORTED);
			};
			if (abortId) pendingAborts.set(abortId, abort);
			requestAborts.set(serverRequest, abort);
			if (!signal) return;
			if (signal.aborted) abort();
			else signal.addEventListener('abort', abort, { once: true });
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
		const {
			url,
			resource,
			integrity: routeIntegrity,
			cacheMark: routeMark,
		} = parseRoutedURL(
			serverRequest.url,
			rewriter.codec,
			`${oURL.origin}${rewriter.directory}`,
		);
		// a refused stylesheet asked for again with the page's metadata on its
		// element (src/sri.ts): bytes that fail that metadata, which the
		// browser refuses itself. Nothing of the origin's is in them and they
		// are answered to whoever asks; any other request ending in the
		// fragment is routed as usual
		if (
			serverRequest.url.endsWith(REFUSED_FRAGMENT) &&
			serverRequest.destination === 'style' &&
			serverRequest.integrity
		) {
			const bytes = refusalBytes(serverRequest.integrity);
			if (bytes)
				return new Response(bytes as Uint8Array<ArrayBuffer>, {
					headers: { 'content-type': 'text/css' },
				});
		}
		// the integrity checked here: the route's, else (a module script whose
		// element named none) the document's import maps' for its URL. One that
		// names nothing valid checks nothing and stands for the element's own
		const integrity =
			routeIntegrity === NO_INTEGRITY
				? ''
				: routeIntegrity ||
					(resource === 'js:genericModule'
						? integrityMark(importMapIntegrity(context?.clientId, url.url.href))
								.slice(INTEGRITY_MARK.length)
								.replace(NO_INTEGRITY, '')
						: '');

		// the same document asking again for an output it was just given, or
		// for an image or a font it was given as it came (REPEAT_DESTINATIONS)
		const recentKey =
			transformBody ||
			(REPEAT_DESTINATIONS.has(serverRequest.destination) &&
				!serverRequest.headers.has('range'))
				? recentOutputKey(serverRequest, context)
				: null;
		// never a hop of a redirect chain: its origin may be "null" by then.
		// One the worker is still reading waits for it
		const recent =
			recentKey !== null &&
			!redirectPending(
				context?.clientId ?? '',
				serverRequest.referrer,
				serverRequest.url,
			)
				? (takeRecentOutput(recentKey) ??
					(await pendingOutputs.get(recentKey)) ??
					null)
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
			// (in resource timing it reads as what the renderer's memory cache
			// answers, messages.ts Delivery: natively the document's own second
			// use of what it has, which is no load at all)
			const headers = new Headers(recent.headers);
			if (!hasMark(headers.get('server-timing'), CACHED_MARKER))
				headers.append('server-timing', CACHED_MARKER);
			if (!hasMark(headers.get('server-timing'), MEMORY_MARKER))
				headers.append('server-timing', MEMORY_MARKER);
			return new Response(recent.body, {
				status: recent.status,
				statusText: recent.statusText,
				headers,
			});
		}

		// the proxy's own origins: this one, and with the site pool the hub's
		// and every slot's (proxyOrigins)
		const proxyOwn =
			url.url.origin === oURL.origin ||
			proxyOrigins(rewriter.config).includes(url.url.origin);
		// a route of a route (a page handed a hook its raw proxy URL, routed
		// again): the real URL is the inner route's, so the request is sent to
		// the single route of it, a document and a subresource alike, on the
		// inner route's origin (with the site pool, a slot's route routed on
		// the hub's origin goes back to the slot that shows its site)
		const unwrapped = proxyOwn
			? unwrapRoute(url.url, rewriter.codec, rewriter.directory)
			: null;
		if (unwrapped) {
			const single = `${url.url.origin}${rewriter.directory}${resource}/${new StompURL(
				unwrapped,
				url,
			).encode()}`;
			return new Response(null, {
				status: 307,
				headers: { location: single, 'cache-control': 'no-store' },
			});
		}

		// Anything else of the proxy's own origin is one more site
		// (proxy-ception, docs/proxyception.md): the demo, its examples, a
		// STomp of its own that proxies a third site. It goes out over the
		// transport as every site does, so what answers is the host's server
		// as any client sees it, never this worker, its controllers or the
		// host's page, and its cookies, storage and service workers are the
		// emulated partition of that origin, as another site's are. (This was
		// a 403 refusal, from before a page of the proxy's origin could be
		// told apart from the host's own: docs/proxyception.md says what each
		// part of it kept and what keeps it now.)

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
		const grant =
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
		// (`^`: a document's its client makes it for, in the partition its
		// site has with another site above it, LoadGrantMessage; the load
		// after it, if any, is what the grant names)
		const crossGranted = grant?.[0] === '^';
		const granted = crossGranted
			? grant!.slice(1) || null
			: (grant ??
				(await workerReportLoad(serverRequest, loadToken, context, url.url)));
		let internal = granted !== null || (!!context?.internal && !context.cors);
		const load = loadOf(granted);
		// a report for the page's report-to endpoint (the request's URL), which
		// this worker delivers as Chrome's Reporting API does, outliving the
		// document (reportUploads.ts)
		if (load?.destination === 'reports') {
			const delivered = queueReport(
				{
					bare: rewriter.bare,
					cookie: async (target) =>
						(
							await rewriter.cookies.get(target, {
								site: 'same-origin',
								navigation: false,
								method: 'POST',
							})
						).header(),
				},
				url.url,
				await serverRequest.text(),
				context?.clientId,
			);
			context?.waitUntil?.(delivered);
			return new Response(null, { status: 204 });
		}
		// a navigation of a window that another document started, which the
		// inject made from that window's realm (NavigationInitiator): that
		// document is its initiator
		const initiated =
			serverRequest.mode === 'navigate'
				? takeNavigationInitiator(url.url.href)
				: null;
		// a page's own request from an opaque origin (a document the page
		// sandboxed without allow-same-origin), or a navigation such a
		// document started
		const opaqueAsked = serverRequest.headers.get(OPAQUE_HEADER);
		const opaque =
			(serverRequest.mode !== 'navigate' && opaqueAsked !== null) ||
			initiated?.origin === 'null';
		requestHeaders.delete(OPAQUE_HEADER);
		// an XMLHttpRequest with upload listeners (the CORS-preflight flag)
		const forcePreflight = serverRequest.headers.has(PREFLIGHT_HEADER);
		requestHeaders.delete(PREFLIGHT_HEADER);
		// an XMLHttpRequest's credentials, for a Basic challenge (httpAuth)
		const urlCredentials = serverRequest.headers.get(CREDENTIALS_HEADER);
		requestHeaders.delete(CREDENTIALS_HEADER);

		requestHeaders.set('user-agent', navigator.userAgent);
		// the browser's network stack adds it after this worker, so no request
		// here carries it: from the user's languages, as Chrome writes it. One
		// the worker sees is the page's own (headerOrder.ts places it)
		const pageLanguage = requestHeaders.has('accept-language');
		if (!pageLanguage) {
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
		const nestedRoute = nestedTopOf(
			oURL.pathname,
			rewriter.directory,
			rewriter.codec,
		);
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
			initiated?.policy ||
			returned?.policy ||
			serverRequest.referrerPolicy ||
			DEFAULT_REFERRER_POLICY;
		const requestReferrer = initiated
			? initiated.referrer
			: returned
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
			const mark = nestedMarkOfKind(kind, rewriter.codec);
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
				)}${rewriter.codec.encode(
					nestedMark(
						parsed.top,
						parsed.crossAncestor,
						{
							...parsed.embedder,
							later: true,
						},
						parsed.sandbox,
						parsed.topOpenerSameOrigin,
						parsed.nonce,
					),
				)}${oURL.pathname.slice(rewriter.directory.length + kind.length)}`;
				rememberReturn(back.href, {
					referrer: requestReferrer,
					policy,
					url: returned?.url ?? serverRequest.url,
				});
				// (and its initiator, for the request that comes back)
				if (initiated) recordNavigationInitiator(url.url.href, initiated);
				const headers = new Headers({
					'content-type': 'text/html; charset=utf-8',
					'cache-control': 'no-store',
				});
				isolationResponseHeaders(headers, {
					isolated: false,
					topLevel: false,
				});
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
		const {
			client,
			clientRoute,
			unknownBlob,
			unknownClient,
			clientTopSite,
		}: ClientFacts =
			!navigation && context?.clientId
				? await clientFacts(context.clientId, decode, routedPrefix, !referrer)
				: NO_CLIENT;

		// the Referer's source: the browser's routed Referer decoded, when it
		// kept the full URL; when the policy made it send the proxy origin
		// only (origin, strict-origin) the client stands in, since only its
		// origin is sent then
		let refererSource = referrer ? decode(referrer) : null;
		if (!refererSource && referrer === `${oURL.origin}/`)
			refererSource = client;
		// A navigation under `origin` or `strict-origin` has no client to
		// stand in: the document that started it told the worker it did
		// (NAVIGATION_HINT; its origin is the sender's own route's, never
		// what the message says), and an origin is all these two policies
		// send. Its message may trail the request a little. Only under these
		// two: the host's own page at the proxy origin's root is that same
		// referrer in full, under the default policy.
		if (
			navigation &&
			!refererSource &&
			referrer === `${oURL.origin}/` &&
			(policy === 'origin' || policy === 'strict-origin')
		) {
			const told = await awaitNavigationHintPeek(
				url.url.href,
				rewriter.config.navigationHintWait ?? NAVIGATION_HINT_WAIT_MS,
			);
			if (told) refererSource = new URL(told.origin);
		}

		// the real document this request belongs to, which the blocker reads as
		// its source and the per-site shields are keyed by (a navigation's: the
		// page that frames it; a subresource's: the document that makes it)
		const blockerSource =
			(navigation
				? (refererSource ?? (nestedRoute ? urlOrNull(nestedRoute) : null))
				: (client ?? refererSource)
			)?.href ?? '';
		// the host whose shields govern this request: a top-level navigation is
		// its own page, otherwise the document that makes the request. A deeply
		// nested third-party frame's subresources are keyed by that frame, not
		// the real top page (phase-1 limit, FINDINGS)
		const shieldsHost = hostOf(
			navigation && topLevel ? reportURL(url) : blockerSource || reportURL(url),
		);

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
					top = nestedTopOf(
						new URL(contextRoute).pathname,
						rewriter.directory,
						rewriter.codec,
					);
				} catch (error) {
					// not a URL: no top to name
				}
			upgradeInsecure =
				upgradesInsecure(
					navigation ? undefined : context?.clientId,
					navigation ? null : clientRoute,
					referrer,
				) ||
				// the site's shields upgrade its HTTP requests (Brave's "upgrade
				// connections to HTTPS"): the mixed-content machinery then rewrites
				// them to https, as a document's own upgrade-insecure-requests would
				!!rewriter.shields?.httpsUpgrade(shieldsHost);
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
		// an earlier hop of the chain was of another origin than the one
		// before it: the page's Authorization went no further than that
		const unauthorized = !!previousHop?.unauthorized;
		if (unauthorized) requestHeaders.delete('authorization');
		// the hosts whose cookies the chain changed the jar with (JAR_MARKER)
		const jarHosts = [...(previousHop?.jar ?? [])];
		const carried = previousHop?.referer;
		// (a document of an opaque origin, one the page sandboxed without
		// allow-same-origin, is no referrer of anything)
		const referer = opaque
			? null
			: carried !== undefined
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
			if (!hint && !known && !referrer && !previousHop && !initiated)
				hint = await awaitNavigationHint(
					url.url.href,
					rewriter.config.navigationHintWait ?? NAVIGATION_HINT_WAIT_MS,
				);
			// (the document that leaves, when it is the one navigating)
			if (hint?.client && hint.own && !hint.opens && !hint.framing)
				leavingClients.set(serverRequest, hint.client);
		}
		const hinted =
			initiated && initiated.origin !== 'null'
				? new URL(initiated.origin)
				: hint && !referrer && !previousHop
					? new URL(hint.origin)
					: null;
		const initiator =
			known ??
			hinted ??
			(previousHop?.initiator ? new URL(previousHop.initiator) : null);
		// the page had user activation when this navigation (or the chain it
		// redirects) began
		// (the initiator's, when another document started it)
		const activated = initiated
			? initiated.activated
			: !!(hint?.activated || previousHop?.user);
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

		// The request's mode as the browser makes it: the inject fetches every
		// copy of a page's load in `cors`, and the copy is that load (its
		// grant names it: a FedCM endpoint the inject reads in the browser's
		// place, an image, a classic script, an embed's navigation), any
		// other copy (a download, a load whose kind the worker takes no
		// metadata from) the browser's own no-cors load of it
		const loadMode = load?.mode ?? (internal ? 'no-cors' : serverRequest.mode);
		// the browser sends Origin on cross-origin CORS requests and on every
		// request with a body; Chrome also on an element's CORS load to its
		// own origin (ORIGIN_ALWAYS), and never on a no-cors load or a GET
		// navigation, an embed's and an object's included (measured in
		// Chrome 157, blank-load-metadata; fedcm for the well-known file,
		// config and accounts, no-cors)
		// (a chain that went from another origin to a third is no origin's any
		// more, its own included: "null", below)
		if (
			(initiator || opaque) &&
			(((!sameOrigin || previousHop?.tainted) && loadMode === 'cors') ||
				(loadMode === 'cors' && ORIGIN_ALWAYS.includes(destination)) ||
				!BODY_ILLEGAL.includes(serverRequest.method))
		)
			requestHeaders.set('origin', opaque ? 'null' : initiator!.origin);
		// an extension's origin judges its web_accessible_resources by who
		// asked, as Chrome judges the initiator (a strict referrer policy
		// leaves no Referer to say it; ./extensions/serve.ts)
		if (extensionOfHost(url.url.hostname)) {
			if (initiator && !opaque)
				requestHeaders.set(EXTENSION_INITIATOR, initiator.origin);
			else requestHeaders.delete(EXTENSION_INITIATOR);
		}

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
				? nestedTopOf(
						new URL(referrer).pathname,
						rewriter.directory,
						rewriter.codec,
					)
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
				(clientRoute
					? routeTopSite(clientRoute, rewriter.directory, rewriter.codec)
					: null) ??
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
		const clientPartition = navigation
			? topLevel
				? ''
				: kindPartition(resource, url.url.origin, publicSuffix, rewriter.codec)
			: clientTopSite
				? `^${clientTopSite}`
				: clientRoute && client
					? routePartition(
							clientRoute,
							rewriter.directory,
							client.origin,
							rewriter.codec,
						)
					: '';
		// a grant's `^` moves a first-party client's request into the
		// partition its site has under itself with another site between
		// (Chrome's ancestor chain bit), and no other
		const contextPartition =
			crossGranted &&
			clientPartition === '' &&
			client &&
			client.origin !== 'null'
				? `^${siteOf(client, publicSuffix)}`
				: clientPartition;
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
		// a credentialless frame's requests are in its partition
		// (partition.ts credentiallessPartition), which Chrome's network
		// state treats as transient: the preflight cache keys by it, and
		// nothing of them is kept in the HTTP cache (measured in Chrome 157:
		// each load goes to the network, and no entry another load made is
		// asked; the credentialless suite), nor in the rewrite cache
		const transient = ephemeralKey(partitionKey);

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
			// (a download the inject saves for a page is the navigation it is
			// natively: Chrome 157, blank-load-metadata)
			requestHeaders.set(
				'sec-fetch-mode',
				load?.mode ??
					(granted === 'download' && internal
						? 'navigate'
						: serverRequest.mode ||
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
		// (src/isolation.ts), when the host's page is isolated, or the
		// document is one the proxy isolates with its own
		// Document-Isolation-Policy (./apartAgent.ts): the browser has the
		// proxy's for every such document, so the page's own is applied
		// here. A `credentialless` one sends its no-cors requests to another
		// origin without credentials, and keeps none from the answer.
		const ownerPolicy =
			(rewriter.isolated || anyApartClient()) && !navigation
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
		// the site's shields cookie policy (Brave's "block third-party cookies"):
		// 'all' sends none, 'third-party' none on a cross-site request, 'allow'
		// (and shields down, and a host with no entry) leaves STomp's own jar and
		// SameSite to decide. This is the send side; STomp already partitions
		// what a cross-site response may set (crossSiteSet, CHIPS)
		const shieldCookies = rewriter.shields?.cookies(shieldsHost) ?? 'allow';
		const shieldBlocksCookie =
			shieldCookies === 'all' ||
			(shieldCookies === 'third-party' && cookieSite === 'cross-site');
		// no cookie to send is no Cookie header, as the browser sends it
		const cookie =
			credentials && !shieldBlocksCookie
				? (
						await rewriter.cookies.get(url.url, {
							site: cookieSite,
							navigation: topLevel,
							method: serverRequest.method,
							partitionKey,
						})
					).header()
				: '';
		if (cookie) requestHeaders.set('cookie', cookie);
		else requestHeaders.delete('cookie');
		// Sec-Fetch-Storage-Access (Chrome 133): a request that may carry
		// credentials and whose site for cookies is another site (it has a
		// partition key: a third-party context, or another site than its
		// top's) says whether it has unpartitioned cookie access, whether
		// or not it has a cookie to send. Measured: Chrome 157 with its
		// default cookie settings sends `active` on every such request (a
		// cross-site image, fetch with credentials, a frame's navigation;
		// Google's sign-in page sends it on its gstatic loads and its
		// CheckConnection frame) and none on a first-party request or one
		// without credentials. Where the shields withhold the cookies of the
		// request, it has no such access: `none`.
		if (
			potentiallyTrustworthy(url.url) &&
			credentials &&
			partitionKey !== undefined
		)
			requestHeaders.set(
				'sec-fetch-storage-access',
				shieldBlocksCookie ? 'none' : 'active',
			);

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
		const policyMode = navigation ? 'navigate' : loadMode;
		const policyOrigin =
			opaque || unknownBlob || previousHop?.tainted
				? 'null'
				: (initiator?.origin ??
					(unknownClient && !refererSource ? 'null' : null));
		const crossOrigin =
			!navigation &&
			policyOrigin !== null &&
			(policyOrigin === 'null' || policyOrigin !== url.url.origin);
		// an extension page reads any response of a host it has permission
		// for, no CORS asked (as Chrome lets it)
		const extensionReads =
			crossOrigin &&
			!!rewriter.extensions?.any &&
			rewriter.extensions.crossOriginAllowed(policyOrigin, url.url);
		const corsChecked = crossOrigin && policyMode === 'cors' && !extensionReads;
		// a subresource the inject copies for a page under a grant: its bytes
		// go to the page's process as a blob (not a download, which the page
		// never holds, nor an object's or embed's document, a navigation)
		const copiedLoad =
			granted !== null &&
			internal &&
			granted !== 'download' &&
			load?.mode !== 'navigate';
		// a FedCM endpoint the browser reads from its own process, no-cors (the
		// well-known file, config, accounts, client metadata): the inject runs
		// the flow, but its body is never in a Response or promise of the
		// page's realm, where page code could take it (a getter of
		// Object.prototype's `then` is handed every Response a fetch resolves
		// with). This worker reads it and posts it on the client's load
		// channel (IDENTITY_READ), and the request is answered empty. Only a
		// grant names this load: the inject's own request, never the page's
		const identityRead =
			load?.destination === 'webidentity' &&
			load.mode === 'no-cors' &&
			loadToken !== null &&
			!!context?.clientId;
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
		// FedCM's client metadata, which Chrome sends as from an opaque origin
		// (Sec-Fetch-Site: cross-site) yet with the relying party's Origin
		// (measured in Chrome 157, the fedcm suite); only the inject's own
		// grant names a webidentity load
		if (
			load?.destination === 'webidentity' &&
			opaqueAsked === 'rp' &&
			initiator &&
			!previousHop
		)
			requestHeaders.set('origin', initiator.origin);
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
		/**
		 * a request the CORS protocol refuses. An EventSource is closed for
		 * good by a failed access check (Chrome: an error event, readyState
		 * CLOSED), where any other network error makes it connect again a few
		 * seconds later, forever: it is answered as the mixed-content refusal
		 * is, with a status that fails the connection
		 */
		const refuseAccess = (error: string, method = serverRequest.method) => {
			const refused = refuse(error, method);
			return requestTypeOf(serverRequest) === 'EventSource endpoint'
				? new Response(null, { status: 204 })
				: refused;
		};
		if (crossOrigin && policyMode === 'same-origin')
			return refuse('blocked: a same-origin request to another origin');
		// a no-cors request to another origin follows its redirects or is
		// none (https://fetch.spec.whatwg.org/#main-fetch): to the browser the
		// route is its own origin, where `manual` and `error` are allowed
		if (
			crossOrigin &&
			!internal &&
			serverRequest.mode === 'no-cors' &&
			serverRequest.redirect !== 'follow'
		)
			return refuse(
				'blocked: a no-cors request to another origin that does not follow redirects',
			);
		// a port the browser connects to for no request (badPorts.ts)
		if (!navigation && badPort(url.url)) return refuse('blocked: unsafe port');

		// the built-in blocker (docs/adblock.md), on the real request and the
		// real document that makes it (a navigation's: the page that frames
		// it), before the host's rules, the page's emulated service worker,
		// the cache and the transport: what the lists block reaches none of
		// them. A request the worker makes for itself is not the page's
		// The page's own policy refuses what natively it refuses, before
		// anything else sees the request (src/csp.ts): the browser judged it
		// by the proxy's URL, where the hosts the policy names mean nothing.
		// It is sent on to a URL the browser's copy of the policy refuses,
		// and the browser refuses it there as the page's policy would have:
		// the load fails as natively, and the violation it reports is the
		// browser's own, naming the first URL of the chain (the inject reads
		// it back as the page's). A copy the inject makes for a document no
		// worker controls fails as a network error.
		// A worker's requests are judged by the worker's own policies (a
		// blob: worker's are its creator's): the browser has no copy of
		// them, so a refused one is a network error, which is how the
		// browser fails it, and the worker's inject reports it as the
		// browser does (WorkerClient.requestVerdict), report-only ones too.
		if (!navigation && (!context?.internal || granted !== null)) {
			const directive = directiveOf(destination);
			// (a blob: worker is known by its creator once one of its
			// requests was looked up)
			if (
				directive !== null &&
				WORKER_DIRECTIVES.includes(directive) &&
				context?.clientId &&
				!knowsPoliciesOf(context.clientId)
			)
				await requestOwner(context.clientId);
			const { policies: refusals, worker: workerClient } =
				directive !== null && WORKER_DIRECTIVES.includes(directive)
					? refusingPolicies(
							context?.clientId,
							requestReferrer,
							destination,
							url.url,
							!!previousHop,
							serverRequest.mode,
							blobCreatorOf,
							creatorOf,
						)
					: { policies: [], worker: false };
			const refusing = refusals.filter(
				(policy) => policy.disposition === 'enforce',
			);
			// only a report-only policy refuses it: it goes out, and the
			// document is told to report it (a request of its connect-src it
			// reported itself, knowing which API made it, as a worker does
			// every one)
			if (
				!refusing.length &&
				refusals.length &&
				granted === null &&
				directive !== 'connect-src' &&
				!workerClient
			)
				postReport(context?.clientId, directive!, url.url);
			if (refusing.length) {
				rewriter.log?.({
					url: reportURL(url),
					method: serverRequest.method,
					destination: serverRequest.destination || 'fetch',
					status: 0,
					ms: Date.now() - started,
					cached: false,
					bytes: null,
					error: `refused by the page's ${directive}`,
					client: context?.clientId,
				});
				return granted !== null || workerClient
					? Response.error()
					: Response.redirect(REFUSED_URL, 302);
			}
		}
		// the page's Integrity-Policy (contentPolicies.ts integrityRefuses):
		// a script it blocks fails as a network error, as natively. A local
		// URL's (data:, blob:) is not blocked
		if (
			!navigation &&
			!context?.internal &&
			ROUTE_PROTOCOLS.includes(url.url.protocol) &&
			integrityRefuses(
				context?.clientId,
				requestReferrer,
				destination,
				serverRequest.mode,
				integrity !== '',
				blobCreatorOf,
			)
		)
			return Response.error();
		// the chain a navigation is a later hop of, as the documents that
		// started it told it (NavigationHint): what judges its hops and the
		// document it ends in
		let chain: NavigationChain | null = null;
		let chainStart = url.url.href;
		if (navigation)
			try {
				if (previousHop?.first)
					chainStart = parseRoutedURL(
						previousHop.first,
						rewriter.codec,
						routedPrefix,
					).url.url.href;
				chain = navigationChain(chainStart);
			} catch (error) {
				// not a route of this controller's: nothing was told of it
			}
		// a frame's csp attribute asks every navigation of the frame for its
		// policy (CSP Embedded Enforcement); the browser never has the
		// attribute (the inject keeps it), so it is said here
		requestHeaders.delete('sec-required-csp');
		if (navigation && nestedRoute !== null && chain?.required)
			requestHeaders.set('sec-required-csp', chain.required);
		// The page's form-action (a form's) and a frame's parent's frame-src
		// judge every hop of the navigation natively. A hop one refuses goes
		// on to a URL the browser's copy refuses too: the browser refuses it
		// as natively, and reports it as Chrome does, a form's by its first
		// URL, a frame's by the URL refused (which namedRefusal's host names)
		// (a hop another slot's worker judged before it sent it here is not
		// judged again, siteDeparture)
		if (chain && previousHop && !judgedArrivals.delete(serverRequest.url)) {
			const refusal = hopRefusal(
				chain,
				url.url,
				nestedRoute !== null,
				chainStart,
			);
			if (refusal !== null) {
				rewriter.log?.({
					url: reportURL(url),
					method: serverRequest.method,
					destination: serverRequest.destination || 'fetch',
					status: 0,
					ms: Date.now() - started,
					cached: false,
					bytes: null,
					error: "refused by the page's policy",
					client: context?.clientId,
				});
				return Response.redirect(refusal, 302);
			}
		}
		const blocker = context?.internal ? undefined : rewriter.blocker;
		// shields down (or the blocker in "allow all") for this site: the
		// ad/tracker layer does not run, as a content blocker the user turned
		// off for the site would not. STomp's rewriting is untouched
		const blocks = !rewriter.shields || rewriter.shields.blocks(shieldsHost);
		// the first navigation after a start waits for the engine: the stored
		// one or, on by default, the directory's snapshot (a second at the
		// most), and, when the host asked for the blocker, a first fetch of
		// the lists, bounded. A document that loads before it is unfiltered
		// for as long as it is open: its scriptlets run before its first
		// script or never, and an app's in-app navigations are that
		// document's (a YouTube watch page played the pre-roll ads of every
		// related video it went on to)
		if (blocker && blocks && navigation && !blocker.ready)
			await blocker.settled(!!rewriter.blockerAsked);
		// standard mode leaves a request of its top-level page's site (a
		// top-level navigation is its own) to the host's own filters, as
		// Brave's does: the lists block third-party trackers only. The site
		// is the registrable domain whatever the scheme (Brave's
		// SameDomainOrHost)
		const pageSite = navigation && topLevel ? null : topSite;
		const firstParty =
			blocks &&
			!!rewriter.shields?.standard(shieldsHost) &&
			(pageSite === null
				? navigation && topLevel
				: pageSite.slice(pageSite.indexOf('//') + 2) ===
					registrableDomain(url.url.hostname, publicSuffix));
		const decision = blocks
			? await blocker?.decide({
					url: reportURL(url),
					source: blockerSource,
					destination,
					navigation,
					topLevel,
					firstParty,
					method: serverRequest.method,
					ping:
						serverRequest.headers.has('ping-to') ||
						(!serverRequest.destination &&
							serverRequest.keepalive &&
							serverRequest.mode === 'no-cors' &&
							serverRequest.method === 'POST'),
				})
			: null;
		if (decision?.block) {
			// as a content blocker's ERR_BLOCKED_BY_CLIENT reaches a page: a
			// network error, nothing of the proxy's in it. A top-level
			// document is the user's own navigation: the host's page says why
			const page =
				navigation && topLevel
					? await hostErrorPage(
							rewriter,
							{
								url: reportURL(url),
								status: 403,
								error: 'blocked by the content blocker',
								kind: 'blocked',
							},
							{ client: context?.clientId },
						)
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
				// the host's page tells the host which client it is, as a proxied page does
				client: context?.clientId,
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

		// the extensions' declarativeNetRequest rules (src/server/dnr.ts), on
		// the real request, as Chrome's network stack asks them before it
		// sends one: a block is the content blocker's network error, a
		// redirect or upgrade the internal redirect Chrome makes (a 307 the
		// browser follows, here again), and the header changes wait for the
		// headers as they go out and come in. A request of the worker's own
		// (an emulated service worker's script) is the browser's, which DNR
		// never sees
		// webRequest's onBeforeRequest goes to the listeners first, and the
		// rules are matched while they answer, as Chrome's
		// WebRequestEventRouter::OnBeforeRequest does: a request a rule blocks
		// or redirects is still told to them, and their answers are dropped
		// (ClearPendingCallbacks). A request the worker makes for itself is
		// nobody's to see
		const extensionRequest: ExtensionRequest | null =
			rewriter.pipeline?.active && !context?.internal
				? rewriter.pipeline.request({
						url: url.url.href,
						method: serverRequest.method,
						destination:
							navigation && topLevel
								? 'document'
								: serverRequest.destination || 'empty',
						navigation,
						top: topLevel,
						initiator: policyOrigin,
						site,
						client: context?.clientId,
					})
				: null;
		const extensionBefore = extensionRequest
			? rewriter.pipeline!.before(extensionRequest).catch(() => null)
			: null;
		const dnrStep =
			context?.internal || !rewriter.dnr?.active
				? null
				: rewriter.dnr.beforeRequest({
						url: url.url.href,
						method: serverRequest.method,
						destination: serverRequest.destination,
						navigation,
						topLevel,
						source: blockerSource,
						ping:
							serverRequest.headers.has('ping-to') ||
							(!serverRequest.destination &&
								serverRequest.keepalive &&
								serverRequest.mode === 'no-cors' &&
								serverRequest.method === 'POST'),
						clientId: context?.clientId,
						resultingClientId: context?.resultingClientId,
						// the routed document that started it, which has a place in
						// the frame tree (a frame's src it set: its parent); not
						// one that may go to another window (a popup, a target)
						startedBy:
							hint?.client && hint.own && !hint.opens
								? { client: hint.client, frameSrc: hint.framing === true }
								: null,
					});
		const dnrFlow: DnrFlow | null = dnrStep?.flow ?? null;
		const dnrAnswer = async (outcome: DnrOutcome): Promise<Response> => {
			const by = outcome.action
				? `extension ${outcome.action.extensionId}, rule ${outcome.action.ruleId}`
				: 'an extension';
			if (outcome.type === 'redirect') {
				rewriter.log?.({
					url: reportURL(url),
					method: serverRequest.method,
					destination: serverRequest.destination || 'fetch',
					status: 307,
					ms: Date.now() - started,
					cached: false,
					bytes: 0,
					error: `redirected by ${by}`,
					client: context?.clientId,
				});
				return new Response(null, {
					status: 307,
					headers: {
						location: routeHTML(
							new StompURL(new URL(outcome.redirectUrl!), url),
							url,
							rewriter.config,
							false,
							nestedMarkOf(oURL.pathname, rewriter.directory, rewriter.codec) ??
								false,
						),
						'cache-control': 'no-store',
					},
				});
			}
			// ERR_BLOCKED_BY_CLIENT, as the built-in blocker's (a collapse is
			// the same error: the element it hides is the page's to hide)
			const page =
				navigation && topLevel
					? await hostErrorPage(
							rewriter,
							{
								url: reportURL(url),
								status: 403,
								error: `blocked by ${by}`,
								kind: 'blocked',
							},
							{ client: context?.clientId },
						)
					: null;
			rewriter.log?.({
				url: reportURL(url),
				method: serverRequest.method,
				destination: serverRequest.destination || 'fetch',
				status: 0,
				ms: Date.now() - started,
				cached: false,
				bytes: null,
				error: `blocked by ${by}`,
				kind: 'blocked',
				// the host's page tells the host which client it is, as a proxied page does
				client: context?.clientId,
			});
			return page ?? Response.error();
		};
		if (dnrStep && dnrStep.outcome.type !== 'none')
			return dnrAnswer(dnrStep.outcome);

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
					client: context?.clientId,
					rule: rule.index,
				});
				return new Response(null, { status, headers });
			};
			if (rule.action === 'block') {
				const page = DOCUMENT_DESTINATIONS.has(serverRequest.destination)
					? await hostErrorPage(
							rewriter,
							{
								url: reportURL(url),
								status: 403,
								error: 'blocked by a rule',
								kind: 'blocked',
							},
							{ client: context?.clientId },
						)
					: null;
				const built = answer(403, undefined, 'blocked by a rule', 'blocked');
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
							nestedMarkOf(oURL.pathname, rewriter.directory, rewriter.codec) ??
								false,
						),
					},
					'redirected by a rule',
				);
			applyHeaderRule(requestHeaders, rule.action.requestHeaders);
		}
		// the webRequest listeners' answer (docs/extensions.md): after the
		// host's rules, which win, and before the caches, as the blocker's
		// decision is
		const extensionVerdict = extensionBefore ? await extensionBefore : null;
		if (extensionVerdict && 'cancel' in extensionVerdict) {
			const page =
				navigation && topLevel
					? await hostErrorPage(
							rewriter,
							{
								url: reportURL(url),
								status: 403,
								error: 'blocked by an extension',
								kind: 'blocked',
							},
							{ client: context?.clientId },
						)
					: null;
			rewriter.log?.({
				url: reportURL(url),
				method: serverRequest.method,
				destination: serverRequest.destination || 'fetch',
				status: 0,
				ms: Date.now() - started,
				cached: false,
				bytes: null,
				error: 'blocked by an extension',
				kind: 'blocked',
				// the host's page tells the host which client it is, as a proxied page does
				client: context?.clientId,
			});
			return page ?? Response.error();
		}
		if (extensionVerdict) {
			// a redirect (or an upgrade) goes to the same kind of route, as
			// a site's own redirect would be followed
			let target: URL;
			try {
				target =
					'redirect' in extensionVerdict
						? new URL(extensionVerdict.redirect, url.url)
						: Object.assign(new URL(url.url), { protocol: 'https:' });
			} catch (error) {
				return Response.error();
			}
			return new Response(null, {
				status: 307,
				headers: {
					location: `${oURL.origin}${rewriter.directory}${resource}/${new StompURL(
						target,
						url,
					).encode()}`,
					'cache-control': 'no-store',
				},
			});
		}

		// the extensions' request header changes, on the headers as they go
		// out (onBeforeSendHeaders: the jar's Cookie among them). What each
		// changed name read before is kept: webRequest's listeners see that
		// (pipeline.send)
		let dnrSent: Map<string, string | null> | undefined;
		if (dnrFlow) {
			const before = extensionRequest ? new Map(requestHeaders) : null;
			if (rewriter.dnr!.sendHeaders(dnrFlow, requestHeaders) && before) {
				dnrSent = new Map();
				const after = new Map(requestHeaders);
				for (const [name, value] of before)
					if (after.get(name) !== value) dnrSent.set(name, value);
				for (const name of after.keys())
					if (!before.has(name)) dnrSent.set(name, null);
			}
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

		// The connections it goes on are its network partition's, as Chrome
		// keys its socket pool (src/transport/networkPartition.ts; measured in Chrome 157,
		// net-partitions): the top-level site, and whether the context is
		// cross-site to it (its own site is another, or an ancestor's is: a
		// context in a partition). The transport is told which in a field it
		// takes off (a page's own field of that name is dropped). A context
		// with no site of its own and no top-level site shares one partition.
		// Chrome also keeps a request without credentials off the connections
		// of those with: not done, since it tells no site anything of
		// another's (and doubles the pools)
		const networkTop = topSite ?? requestFrameSite;
		const networkPartition =
			networkTop === null
				? 'opaque'
				: `${networkTop} ${
						networkTop !== requestFrameSite ||
						partitionSite(contextPartition) !== null
							? 'cross-site'
							: 'same-site'
					}`;
		const partitioned = (headers: RawHeaders): RawHeaders => [
			...headers.filter(([name]) => name.toLowerCase() !== NETWORK_PARTITION),
			[NETWORK_PARTITION, networkPartition],
		];
		// and it waits for one as Chrome's requests wait for a socket
		// (src/transport/socketPool.ts): six at a time to an HTTP/1 server
		// for those with credentials and six for those without, the most
		// urgent first. The transport takes the field off
		const queued = (
			headers: RawHeaders,
			urgency: number,
			credentialed: boolean,
			id: string,
			image = false,
		): RawHeaders => [
			...headers.filter(([name]) => name.toLowerCase() !== REQUEST_QUEUE),
			[REQUEST_QUEUE, queueValue(urgency, credentialed, id, askedAt, image)],
		];
		// under its name there, a request the page gives up on leaves the
		// line (Chrome drops it from its socket pool's queue) and an image
		// the page lays out in its viewport is raised (imagesSeen)
		const requeue = (id: string, op: 'cancel' | 'raise') =>
			(
				rewriter.bare.transport as {
					requeue?: (id: string, op: 'cancel' | 'raise') => void;
				}
			).requeue?.(id, op);
		const queueName = () => {
			const id = `${QUEUE_PREFIX}${++queueCount}`;
			abortedSoon.catch(() => requeue(id, 'cancel'));
			return id;
		};
		// the fields go out in the order Chrome sends them (headerOrder.ts)
		const shape: RequestShape = {
			navigation: navigation && DOCUMENT_DESTINATIONS.has(destination),
			destination: navigation && topLevel ? 'document' : destination,
			mode:
				load?.mode ??
				(serverRequest.mode || (destination === 'empty' ? 'cors' : 'no-cors')),
			method: serverRequest.method,
			cache: serverRequest.cache,
			pageLanguage,
		};
		// what the transport said of the origin's last answer (responseFacts.ts)
		let upstreamFacts: ResponseFacts | null = null;
		const fetchUpstream = (headers: Headers) => {
			upstreamFacts = null;
			const id = queueName();
			const image = !shape.navigation && shape.destination === 'image';
			const raise = () => requeue(id, 'raise');
			// what the image's src reads to the browser's own getter: the
			// request's URL, the fragment aside
			const page = serverRequest.url;
			const client = context?.clientId;
			const first = image && (noted ? noted.first : firstImage(client));
			if (image) {
				let raises = unansweredImages.get(page);
				if (!raises) unansweredImages.set(page, (raises = new Set()));
				raises.add(raise);
				if (client) imageClients.set(id, client);
			}
			if (first && !headers.has('priority'))
				headers.set('priority', `u=${FIRST_IMAGES_URGENCY}, i`);
			let urgency = queueUrgency(shape);
			if (first) urgency = Math.min(urgency, FIRST_IMAGES_URGENCY);
			if (image && seenLately(page)) urgency = Math.min(urgency, SEEN_URGENCY);
			const upstream = upload.then(async (body) => {
				let ordered = chromeOrderedHeaders(headers, shape);
				// onBeforeSendHeaders and DNR's header changes, on the fields as
				// they go out (docs/extensions.md)
				if (extensionRequest) {
					const sent = await rewriter.pipeline!.send(
						extensionRequest,
						ordered,
						// (the proxy's own fields come after, never seen)
						(name) => name.startsWith('$stomp$'),
						dnrSent,
					);
					if (!sent) throw extensionRefusal();
					ordered = sent;
				}
				const response = await rewriter.bare.fetch(url.toString(), {
					method: serverRequest.method,
					redirect: 'manual',
					// redirect: serverRequest.redirect,
					body,
					headers: queued(
						partitioned(ordered),
						urgency,
						credentials,
						id,
						image,
					),
				});
				upstreamFacts = factsOf(response.rawHeaders) ?? null;
				if (!extensionRequest) return response;
				const received = await rewriter.pipeline!.received(
					extensionRequest,
					response.status,
					response.statusText,
					response.rawHeaders ?? [...response.headers],
				);
				if (!received) return response;
				if (received.cancel) {
					response.body?.cancel().catch(() => {});
					throw extensionRefusal();
				}
				const answer = BareResponse.fromTransferrableResponse(
					received.redirect
						? {
								body: '',
								status: 307,
								statusText: 'Internal Redirect',
								headers: [['location', received.redirect]],
							}
						: {
								body: response.body as ReadableStream,
								status: response.status,
								statusText: response.statusText,
								headers: received.headers!,
							},
					response.url || url.toString(),
				);
				if (received.redirect) response.body?.cancel().catch(() => {});
				return answer;
			});
			// a start's list downloads wait for the first navigation's answer
			if (shape.navigation) navigationUpstream(upstream);
			if (image) {
				const answered = () => {
					imageClients.delete(id);
					const raises = unansweredImages.get(page);
					raises?.delete(raise);
					if (raises?.size === 0) unansweredImages.delete(page);
				};
				upstream.then(answered, answered);
			}
			// an answer that arrives after the page gave up is dropped unread, so
			// the transport stops reading it
			upstream.then(
				(response) => {
					if (aborted) response.body?.cancel().catch(() => {});
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
			response: fromPageWorker,
			control,
			controller,
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
		// an extension's own pages: its service worker's (./extensions/fetchEvents.ts)
		const fromWorker =
			fromPageWorker ??
			(await answerFromExtensionWorker(
				rewriter,
				serverRequest,
				url,
				context,
				upload,
				referer ?? '',
				navigation,
				navigation && topLevel ? 'document' : serverRequest.destination,
				client,
			));
		// the worker gave the page a network error
		if (fromWorker?.type === 'error') return Response.error();

		// The mark of the documents of the site that asks, under the emulated
		// worker that controls them (src/memoryMark.ts): what this worker
		// routes for the request (a document's shell, a stylesheet's url()s)
		// carries it, and a load whose route carries it is one of those
		// documents', which the renderer may keep and hand to the next of them
		// as natively. None for a client a policy of which governs those loads
		// (MARK_DIRECTIVES): the renderer would answer them past the judgment
		// of this worker (a navigation's document has its own policies, which
		// its inject reads)
		const siteMark =
			!navigation &&
			policiesGovern(
				context?.clientId,
				requestReferrer,
				MARK_DIRECTIVES,
				blobCreatorOf,
			)
				? ''
				: cacheMarkOf(requestFrameSite, controller);
		url.mark = siteMark;

		// a cross-origin request the CORS protocol does not let go out as it
		// is asks first (when it reaches the network: a request the page's
		// emulated service worker answers is that worker's to make): an OPTIONS with the method and the page's headers
		// that are not safelisted, without credentials; its answer must allow
		// both, and is kept for its max-age
		if (corsChecked && !fromWorker) {
			const unsafe = unsafeHeaderNames(
				serverRequest.headers,
				(name) =>
					notPagesHeader(name) || (unauthorized && name === 'authorization'),
			);
			// kept per network partition, as Chrome keeps its preflight cache
			const preflightPartition = `${transient ? partitionKey : (topSite ?? '')} ${requestFrameSite ?? ''}`;
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
				const preflightShape: RequestShape = {
					navigation: false,
					destination,
					mode: 'cors',
					method: 'OPTIONS',
					preflight: true,
				};
				let allowed = false;
				try {
					const answer = await Promise.race([
						rewriter.bare.fetch(url.toString(), {
							method: 'OPTIONS',
							redirect: 'manual',
							headers: queued(
								partitioned(
									chromeOrderedHeaders(preflightHeaders, preflightShape),
								),
								queueUrgency(preflightShape),
								// a preflight never carries credentials
								false,
								queueName(),
							),
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
					return refuseAccess(
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
		// (an opaque origin's image or font load, by its route's mark: none,
		// as for its other loads, src/memoryMark.ts)
		const frameSite = routeMark === OPAQUE_MARK ? null : requestFrameSite;
		const cacheKey =
			frameSite === null || transient
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
		// a short image or font is read whole before it is answered
		// (wholeResponse)
		const wholeKind =
			!navigation &&
			!transformBody &&
			serverRequest.method === 'GET' &&
			WHOLE_DESTINATIONS.has(destination);
		if (memoryDestination) {
			requestHeaders.delete('if-none-match');
			requestHeaders.delete('if-modified-since');
		}
		// ...except a load of its own site's documents, by a route that carries
		// their mark (src/memoryMark.ts), of a body this worker hands on as the
		// origin sent it: it goes to the renderer with the origin's caching
		// headers, so the renderer's memory cache keeps it for that site's
		// next document as natively, under a URL no other site's document
		// writes
		const siteShared =
			memoryDestination &&
			!transformBody &&
			MARKED_KINDS.has(resource) &&
			routeMark !== '' &&
			routeMark === siteMark;
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
		// A step of a frame's history the controller takes with
		// location.replace (another frame's entries came after this one's,
		// src/controller/history.ts) is a history step all the same: it
		// takes the kept document, as the browser's traversal does
		if (navigation && cacheMode === 'default' && rewriter.historySteps) {
			const stepped = serverRequest.url.split('#')[0];
			const until = rewriter.historySteps.get(stepped);
			if (until !== undefined) {
				rewriter.historySteps.delete(stepped);
				if (until > Date.now()) cacheMode = 'force-cache';
			}
		}
		// A host page that was reloaded shows its page again with a new
		// navigation, which takes the reload's mode: `no-cache` for the
		// document after a reload, `reload` for the document and what it
		// loads after a hard one, as natively.
		const now = Date.now();
		// (a document a hard reload makes: hardLoads)
		let hardLoaded = false;
		const restored = rewriter.hostReload;
		if (
			restored &&
			cacheMode === 'default' &&
			navigation &&
			topLevel &&
			now < restored.until
		) {
			cacheMode = shape.cache = restored.mode;
			hardLoaded = restored.mode === 'reload';
		}
		// A frame's document reloaded past the caches (Frame.reload's
		// `bypassCache`, the controller's word): Chrome's LOAD_BYPASS_CACHE.
		// The reload asks for the document with no-cache and Pragma, and so
		// does every request of the document it makes until it loaded
		if (
			navigation &&
			rewriter.hardReloads &&
			(cacheMode === 'default' || cacheMode === 'no-cache')
		) {
			const reloaded = serverRequest.url.split('#')[0];
			const until = rewriter.hardReloads.get(reloaded);
			if (until !== undefined) {
				rewriter.hardReloads.delete(reloaded);
				if (until > now) {
					cacheMode = shape.cache = 'reload';
					hardLoaded = true;
				}
			}
		}
		// and so does a frame such a document makes before its load event,
		// which comes from it (its Referer in the proxy's address space)
		if (
			navigation &&
			!topLevel &&
			cacheMode === 'default' &&
			hardLoading(serverRequest.referrer, now)
		) {
			cacheMode = shape.cache = 'reload';
			hardLoaded = true;
		}
		if (hardLoaded && context?.clientId)
			hardLoad(context.clientId, serverRequest.url, now);
		if (!navigation && cacheMode === 'default' && context?.clientId) {
			const load = hardLoads.get(context.clientId);
			if (load && load.until > now) cacheMode = shape.cache = 'reload';
			else if (load) hardLoads.delete(context.clientId);
		}
		// `force-cache` and `only-if-cached` take an entry however stale; a
		// navigation that asks for the latter (history, to a form's result)
		// goes on to the network for what is not kept, since a POST's answer
		// never is
		const takesStale =
			cacheMode === 'force-cache' || cacheMode === 'only-if-cached';
		// (a navigation that takes a stale entry is Back or Forward: Chrome
		// asks its HTTP cache so for a history step alone, and the entry is
		// the page that step shows again, whatever cookies were set since)
		const historyStep = navigation && takesStale;
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
				? await cache.match(cacheKey!, requestHeaders, historyStep)
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
		// partition, and the answer that says so is not kept either. Its other
		// types are acted on for the site alone (clearSiteData.ts), and it
		// never reaches the browser (filterHeaders).
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
				const [forStore, forPage] = splitForStore(
					upstream.body,
					upstream.headers,
				);
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
			} else if (wholeKind && wholeLength(upstream)) {
				response = await wholeResponse(upstream);
				const blob = wholeBodies.get(response);
				if (blob && storable(upstream.status, upstream.headers))
					cache!.put(cacheKey!, requestHeaders, upstream, blob);
			} else if (upstream.body && storable(upstream.status, upstream.headers)) {
				const [forStore, forPage] = splitForStore(
					upstream.body,
					upstream.headers,
				);
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
		// an HTTP cache entry of one: the store's Blob, which the browser
		// hands over without reading it
		if (
			wholeKind &&
			cached &&
			!memory &&
			response === hit?.response &&
			wholeLength(response)
		)
			response = await wholeResponse(response);

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
		const fromOrigin =
			!fromWorker && !cached && !revalidated && potentiallyTrustworthy(url.url);
		// the rest of Clear-Site-Data, for the site alone (clearSiteData.ts),
		// done before the page has the answer, as natively
		if (fromOrigin && response.headers.has('clear-site-data'))
			await clearSiteData(
				siteDataTypes(response.headers.get('clear-site-data')),
				url.url,
				contextPartition,
				partitionKey,
				rewriter.cookies,
				rewriter.storage,
			);
		const cleared = fromOrigin && clears(response.headers);
		if (cleared) {
			await rewriter.cache?.clearOrigin(url.url.origin);
			memoryCache.clearOrigin(url.url.origin);
			// what the renderer keeps under the sites' marks is no later
			// document's either (cacheMarks.ts)
			await renewCacheSecret();
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
			const whole = wholeBodies.get(response);
			if (whole) memoryCache.keep(memoryKey, requestHeaders, response, whole);
			else {
				const [kept, forPage] = splitForStore(response.body, response.headers);
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

		// the extensions' rules on the response's headers (onHeadersReceived:
		// the rules with response header conditions, then the header
		// changes), before the jar takes its Set-Cookie lines and the
		// rewriter reads the rest; a navigation's document then commits in
		// its frame, which its subresources' allowAllRequests read
		if (dnrFlow && !fromWorker) {
			const lines = headerLinesOf(response.headers, response.rawHeaders);
			const received = rewriter.dnr!.receiveHeaders(dnrFlow, lines);
			if (received.outcome.type !== 'none') {
				await response.body?.cancel().catch(() => {});
				return dnrAnswer(received.outcome);
			}
			if (received.lines) {
				const { headers, cookies } = splitHeaderLines(received.lines);
				const edited: typeof response = new Response(response.body, {
					status: response.status,
					statusText: response.statusText,
					headers,
				});
				edited.rawHeaders = [
					...(response.rawHeaders ?? []).filter(
						([name]) => name.toLowerCase() !== 'set-cookie',
					),
					...cookies,
				];
				response = edited;
			}
			if (
				navigation &&
				!(
					REDIRECT_STATUSES.includes(response.status) &&
					response.headers.has('location')
				)
			)
				rewriter.dnr!.committed(dnrFlow, received.lines ?? lines);
		} else if (dnrFlow && navigation) rewriter.dnr!.committed(dnrFlow, null);

		// the page gave up on this request while the origin was answering: the
		// body is cancelled (the transport stops reading) and the request is
		// reported as aborted; an abort after the headers went out cancels the
		// response stream the browser holds, which reaches the transport the
		// same way
		if (aborted) {
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
			return refuseAccess('blocked by CORS policy');
		}
		// a cors request is not redirected to a URL with credentials, unless
		// the whole chain and that URL are the initiator's own origin
		// (https://fetch.spec.whatwg.org/#http-redirect-fetch). The browser
		// follows the route, which has none
		if (
			fromNetwork &&
			policyMode === 'cors' &&
			policyOrigin !== null &&
			REDIRECT_STATUSES.includes(response.status)
		) {
			const location = response.headers.get('location');
			const to = location === null ? null : locationURL(location, url.url);
			if (
				to &&
				(to.username !== '' || to.password !== '') &&
				(crossOrigin || to.origin !== policyOrigin)
			) {
				await response.body?.cancel().catch(() => {});
				return refuse('blocked: a CORS redirect to a URL with credentials');
			}
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
		// (a worker's script's policy as the browser reads it: WebKit has no
		// credentialless, src/isolation.ts IsolationEngine)
		const workerScript =
			(rewriter.isolated || !!ownerPolicy) &&
			fromNetwork &&
			(serverRequest.destination === 'worker' ||
				serverRequest.destination === 'sharedworker') &&
			!REDIRECT_STATUSES.includes(response.status);
		const workerPolicy = workerScript
			? await byEngine(rewriter.isolationEngine, (engine) =>
					embedderPolicy(
						response.headers.get('cross-origin-embedder-policy'),
						engine,
					),
				)
			: 'unsafe-none';
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
					workerScript &&
					workerPolicy === 'unsafe-none' &&
					!ownerPolicy.frame))
		) {
			await response.body?.cancel().catch(() => {});
			return refuse('blocked by Cross-Origin-Embedder-Policy');
		}
		// a worker's own policy is its script's, for the loads it makes
		if (workerScript) {
			const policy = workerPolicy;
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
		// (but for a FedCM endpoint's, which the browser reads in its own
		// process and this worker reads in its place: identityRead)
		if (
			fromNetwork &&
			chainCrossed &&
			policyMode === 'no-cors' &&
			(serverRequest.destination === 'script' || copiedLoad) &&
			!identityRead &&
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
		// the Document-Isolation-Policy of the proxy's own the document is
		// served with, when the host's page is not isolated (src/isolation.ts
		// servedIsolationPolicy): a top-level document isolated natively, and
		// every document nested in one, are put in an agent cluster of their
		// own, isolated by it, and judged as under an isolated host. A nested
		// one's route says its embedder is such a document (its group: only a
		// document with the host's isolation, or this policy, names one)
		let apart: IsolationPolicy | null = null;
		// the embedder policy the document's own loads are judged by (its
		// Document-Isolation-Policy's, when it sent no embedder policy)
		let loads: EmbedderPolicy = 'unsafe-none';
		// the document is a credentialless frame's that sent no embedder policy
		// of its own: Chrome starts its worker whose script has none either
		// (measured, Chrome 157: isolated, as the frame is)
		let frameCredentialless = false;
		// a redirect on the way to a frame needs no embedder policy, but one
		// of another origin than the embedder's still needs the resource
		// policy (measured)
		const navigationRedirect =
			REDIRECT_STATUSES.includes(response.status) &&
			response.headers.has('location');
		// (each by the rules of the browser this runs in where engines differ:
		// src/isolation.ts IsolationEngine)
		const nestedEmbedder = () => {
			const mark = nestedMarkOf(
				oURL.pathname,
				rewriter.directory,
				rewriter.codec,
			);
			return (mark !== null ? parseNestedMark(mark) : null)?.embedder ?? null;
		};
		if (
			navigation &&
			(rewriter.isolated ||
				// (a policy Chrome ignores where the origin is not potentially
				// trustworthy, as it ignores the headers that isolate natively)
				(trustworthy(url.url.origin) &&
					(topLevel || !!nestedEmbedder()?.apart)))
		) {
			const real = isolationHeaders(response.headers);
			const origin = url.url.origin;
			if (topLevel) {
				if (!navigationRedirect) {
					const decided = await byEngine(rewriter.isolationEngine, (engine) => {
						const isolation = topLevelIsolation(real, origin, engine);
						return {
							isolation,
							loads: loadsPolicy(isolation, real, engine),
							// (not with the site pool, whose agents would not reach
							// such a document: src/controller/site.ts)
							apart:
								!rewriter.isolated &&
								!rewriter.config.sites &&
								engine.dip &&
								isolation.isolated
									? servedIsolationPolicy(real, engine)
									: null,
						};
					});
					// a host that is not isolated: a page that is not isolated
					// natively is served as before (one that is, where the
					// browser has no such policy, as before too: the host is told)
					if (
						!rewriter.isolated &&
						!decided.apart &&
						decided.isolation.isolated &&
						context?.clientId
					)
						rewriter.isolationWanted?.(context.clientId);
					if (rewriter.isolated || decided.apart) {
						isolation = {
							...decided.isolation,
							topLevel: destination === 'document',
						};
						loads = decided.loads;
						apart = decided.apart;
					}
				}
			} else {
				const embedder = nestedEmbedder() ?? {
					origin: '',
					coep: false,
					group: false,
					delegates: 'none' as const,
					origins: [],
					credentialless: false,
					later: false,
					apart: false,
				};
				let sameSite = false;
				try {
					sameSite =
						siteBetween(new URL(embedder.origin), url.url) !== 'cross-site';
				} catch (error) {
					// an embedder without an origin: another site
				}
				const decided = await byEngine(rewriter.isolationEngine, (engine) => {
					const isolation = nestedIsolation(real, origin, embedder, engine);
					return {
						refused: embedderRefuses(
							response.headers,
							origin,
							embedder,
							sameSite,
							navigationRedirect,
							engine,
						),
						isolation,
						loads: loadsPolicy(isolation, real, engine),
						// (one that is not isolated natively is in the cluster all
						// the same, where its embedder reaches it: its inject
						// answers as a document that is not, `n`)
						apart: rewriter.isolated
							? null
							: servedIsolationPolicy(real, engine),
					};
				});
				if (decided.refused) {
					await response.body?.cancel().catch(() => {});
					return refuse('blocked by Cross-Origin-Embedder-Policy');
				}
				if (!navigationRedirect) {
					isolation = { ...decided.isolation, topLevel: false };
					loads = decided.loads;
					apart = decided.apart;
				}
				frameCredentialless =
					embedder.credentialless &&
					embedderPolicy(real.coep) === 'unsafe-none';
			}
		}

		// the report is made now (its time is to the headers) and sent once the
		// body's transform has said how it went
		// the registration that controls the document this navigation makes:
		// its shell says so before the page's first script
		const note: Note = control ? { serviceWorker: control } : {};
		// a document a hard reload made says when its load event is over
		if (hardLoaded) note.hardLoad = true;
		// what the transport said of the origin's answer, when the network
		// gave it (responseFacts.ts; the cast: the compiler does not follow
		// fetchUpstream's assignment)
		const answerFacts =
			cached || revalidated || fromWorker
				? null
				: (upstreamFacts as ResponseFacts | null);
		// the bytes its body came as, which its end says (SIZE_MARKER)
		if (answerFacts?.encodedBytes) note.encodedBytes = answerFacts.encodedBytes;
		// what the document's shell tells its client of its isolation, and
		// its own embedder policy for the loads it makes
		if (isolation) {
			note.isolation = isolationFacts(isolation, !!apart);
			if (apart) {
				note.apart = apart;
				rememberApartClient(context?.clientId);
				rewriter.apartServed?.();
			}
			rememberEmbedderPolicy(
				serverRequest.url,
				context?.clientId,
				loads === 'unsafe-none'
					? null
					: {
							policy: loads,
							// (a Document-Isolation-Policy asks nothing of the
							// document's workers)
							...(frameCredentialless || isolation.coep === 'unsafe-none'
								? { frame: true as const }
								: {}),
						},
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
			response.status,
			url,
			// a redirect keeps the integrity its load carries: the browser
			// checks the response at the end of the chain
			(target, base) =>
				withIntegrityMark(
					transformRoute(target, base, resource),
					(routeIntegrity || integrity) &&
						INTEGRITY_MARK + (routeIntegrity || integrity),
					rewriter.directory,
				),
			additionalResponseFilter,
		);
		// the origin's own Server-Timing metrics, before any mark of the
		// worker's is added: one named like a mark is not taken for one
		// (an emulated service worker's answer is the worker's already)
		if (!fromWorker) escapeSiteMetrics(responseHeaders);
		// a fetch or an XMLHttpRequest reads a response's policy headers as
		// natively (the browser applies none of them to such a response); a
		// document's and a worker's reach the browser as the proxy gives them
		// (src/csp.ts)
		if (serverRequest.destination === '' && !navigation)
			for (const name of [
				'content-security-policy',
				'content-security-policy-report-only',
			]) {
				const value = response.headers.get(name);
				if (value !== null) responseHeaders.set(name, value);
			}
		if (apart) responseHeaders.set('document-isolation-policy', apart);
		else if (isolation)
			isolationResponseHeaders(responseHeaders, {
				...isolation,
				// a popup's document that natively leaves its opener's browsing
				// context group (src/coop.ts, as its hint told the facts): every
				// window of an isolated host is kept in the host's group by the
				// COOP it is served with, so this one is served without it
				severed:
					isolation.topLevel &&
					!!chain?.coop &&
					switchesGroup(
						chain.coop,
						openerPolicy(
							response.headers.get('cross-origin-opener-policy'),
							url.url.origin,
						),
						url.url.origin,
					),
			});
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
		// document that has one (every proxied document, in an isolated host,
		// and a dialed one, which keeps its call page's)
		else if (
			(rewriter.isolated || calledClient(context?.clientId)) &&
			(serverRequest.destination === 'worker' ||
				serverRequest.destination === 'sharedworker')
		)
			responseHeaders.set(
				'cross-origin-embedder-policy',
				SERVED_EMBEDDER_POLICY,
			);
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
		// (and a cors response of its own has a status the page's resource
		// timing shows, as a cors answer from the network has: CORS_MARKER)
		else if (responseHeaders.get(RESPONSE_TYPE_HEADER)?.startsWith('cors'))
			responseHeaders.append('server-timing', CORS_MARKER);
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
		// (every hop of another origin has to allow it: a redirect chain that
		// went through one that did not is restricted to its end, and one that
		// came back to the page's origin past hops that all allowed it is
		// shown, though the entry's name is another origin's)
		const timingDenied =
			fromNetwork &&
			(!!previousHop?.timingDenied ||
				(crossOrigin && !timingAllowed(response.headers, policyOrigin!)));
		const timingShown = fromNetwork && chainCrossed && !timingDenied;
		// (only script reads them: the page's own fetch or XMLHttpRequest, or
		// its emulated service worker's fetch of an element's request; an
		// element's own cors load is the whole response to the browser, whose
		// media element needs a 206's Content-Range, amazon.com's videos)
		if (
			(fromNetwork &&
				corsChecked &&
				(serverRequest.destination === '' ||
					serviceWorkers.isEmulated(
						context?.clientId,
						clientRoute ?? undefined,
					))) ||
			opaqueFetch
		) {
			const location = responseHeaders.get('location');
			const serverTiming = responseHeaders.get('server-timing');
			const encoding = responseHeaders.get('content-encoding')?.trim();
			responseHeaders = opaqueFetch
				? new Headers()
				: exposedHeaders(responseHeaders, credentialsIncluded);
			// (and the entry's contentEncoding from the header, which is not
			// one the page may read either: the inject is told it apart)
			if (
				!opaqueFetch &&
				encoding &&
				/^[\w-]+$/.test(encoding) &&
				!responseHeaders.has('content-encoding')
			)
				responseHeaders.append(
					'server-timing',
					`${ENCODING_MARKER};desc=${encoding}`,
				);
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
		) {
			responseHeaders.append('server-timing', OPAQUE_MARKER);
			// (and one that ended at another origin than the request's says
			// so too: what a worker's importScripts() mutes, AWAY_MARKER)
			if (!sameOrigin) responseHeaders.append('server-timing', AWAY_MARKER);
		}
		// (a video or sound says so before its load is over, which is when the
		// mark can be read: the inject asks, mediaLoads.ts)
		if (
			!redirect &&
			(serverRequest.destination === 'video' ||
				serverRequest.destination === 'audio') &&
			hasMark(responseHeaders.get('server-timing'), OPAQUE_MARKER)
		)
			await recordCrossedMedia(previousHop?.first ?? serverRequest.url);
		// the page's resource timing of another origin's load is restricted
		// unless its Timing-Allow-Origin names the page: the inject reads this
		// mark (and takes it out of the headers a fetch or XHR shows)
		if (timingShown) responseHeaders.append('server-timing', TAO_MARKER);
		// (a chain that began at the page's own origin has its name: the
		// inject is told that it went where the page may not see)
		else if (timingDenied && !redirect)
			responseHeaders.append('server-timing', TIMING_DENIED_MARKER);
		// the status and content type of another origin's answer are in the
		// page's resource timing when the request was a cors one (it passed
		// the check, or the page got a network error instead)
		if (fromNetwork && chainCrossed && policyMode === 'cors' && !redirect)
			responseHeaders.append('server-timing', CORS_MARKER);
		// what a style sheet of another origin loads is in no resource timing
		// when the page took the sheet without cors (the sheet's content is
		// not the page's to learn from its entries): the sheet is remembered
		// by the client and its address, which its loads name as their
		// referrer, and each of them is marked for the inject to leave out
		// (UNREPORTED_MARKER). A sheet such a sheet imports is one too.
		if (!navigation && !redirect) {
			const fromOpaqueSheet =
				!!serverRequest.referrer &&
				opaqueSheets.has(sheetKey(context?.clientId, serverRequest.referrer));
			if (fromOpaqueSheet)
				responseHeaders.append('server-timing', UNREPORTED_MARKER);
			if (
				serverRequest.destination === 'style' &&
				(fromOpaqueSheet ||
					(fromNetwork && chainCrossed && policyMode === 'no-cors'))
			) {
				opaqueSheets.add(sheetKey(context?.clientId, serverRequest.url));
				if (opaqueSheets.size > OPAQUE_SHEETS)
					opaqueSheets.delete(opaqueSheets.values().next().value!);
			}
			// the script of a dedicated worker (WORKER_SCRIPT_MARKER)
			if (serverRequest.destination === 'worker')
				responseHeaders.append('server-timing', WORKER_SCRIPT_MARKER);
		}
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
		// the protocol the origin's answer came over, which the browser has
		// as none for the worker's answer (PROTOCOL_MARKER), and when the
		// steps of its connection happened (CONNECTION_MARKER)
		if (!redirect && answerFacts?.protocol)
			responseHeaders.append(
				'server-timing',
				`${PROTOCOL_MARKER};desc="${answerFacts.protocol}"`,
			);
		if (!redirect && answerFacts?.connection)
			responseHeaders.append(
				'server-timing',
				`${CONNECTION_MARKER};desc=${connectionMark(answerFacts.connection)}`,
			);
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
					...(unauthorized ||
					crossOriginLocation(response.headers.get('location'), url)
						? { unauthorized: true }
						: {}),
					...(timingDenied ? { timingDenied: true } : {}),
					...(grant !== null && loadToken !== null
						? { grant: { token: loadToken, load: grant } }
						: {}),
					first: previousHop?.first ?? serverRequest.url,
					// (filled below, when this hop's cookies are stored)
					jar: jarHosts,
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
						nested: nestedMarkOfKind(next.resource, rewriter.codec) ?? false,
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

		// preloads announced by the server fetch through the proxy too. Chrome
		// acts on a Link header only for a document's own response (measured,
		// Chrome 157: a script's, a stylesheet's, an image's, a fetch's and an
		// XHR's announce nothing), and no page reads a document's headers; so
		// only a navigation's is rewritten, and fetch() and XHR read every
		// other one as the server sent it (link-readback)
		if (navigation && responseHeaders.has('link'))
			responseHeaders.set(
				'link',
				rewriteLinkHeader(
					responseHeaders.get('link')!,
					(target, params, raw) => {
						const resource = new StompURL(new URL(target, url.toString()), url);
						const rewritten = (href: string) => ({ href, rewritten: true });
						// a script's or a stylesheet's integrity rides in its route, for
						// this worker to check the origin's bytes against (src/sri.ts);
						// the page's element of it carries the same, so the element takes
						// the preload
						const checked = (href: string) =>
							rewritten(markIntegrity(href, raw.integrity, rewriter.directory));
						if (params.as === 'style') return checked(routeCSS(resource, url));
						if (params.rel === 'modulepreload')
							return checked(
								routeJS(resource, url, rewriter.config, 'genericModule'),
							);
						if (params.as === 'script')
							return checked(
								routeJS(resource, url, rewriter.config, 'generic'),
							);
						if (params.as === 'document' || params.rel === 'prefetch')
							return rewritten(routeHTML(resource, url, rewriter.config));
						// fonts, images, fetches: /binary/ hands on the origin's body
						return { href: routeBinary(resource), rewritten: false };
					},
				),
			);

		const outcomes: [string, JarCookie | null][] = [];
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
						outcomes,
					);
			}
		}
		// the page's inject tells the other documents of the site before the
		// page sees the answer (JAR_MARKER)
		if (outcomes.length && !jarHosts.includes(url.url.hostname))
			jarHosts.push(url.url.hostname);
		// a new document tells no other of the change: the windows hear of it
		// before the navigation is answered (src/server/Cookies.ts changesTold)
		if (outcomes.length && navigation) await changesTold(CHANGE_TOLD_MS);
		if (jarHosts.length && !redirect)
			responseHeaders.append(
				'server-timing',
				`${JAR_MARKER};desc="${jarHosts.join(' ')}"`,
			);

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
			// A hop the page's policies refuse (a form's form-action, the
			// parent's frame-src) is refused where the navigation is: the
			// browser judges a form's submission by its document's policy in
			// the context that submitted it, and reports it there, and the
			// frame keeps its context, as natively
			if (chain) {
				let refusal: string | null = null;
				try {
					refusal = hopRefusal(
						chain,
						new URL(response.headers.get('location')!, url.url),
						true,
						chainStart,
						false,
					);
				} catch (error) {
					// no URL: the redirect goes nowhere either way
				}
				if (refusal !== null) return Response.redirect(refusal, 302);
			}
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
			isolationResponseHeaders(headers, {
				isolated: false,
				topLevel: false,
			});
			// (in the cluster of a document the proxy isolates, whose frame
			// element it reaches)
			if (!rewriter.isolated && nestedEmbedder()?.apart)
				headers.set('document-isolation-policy', 'isolate-and-credentialless');
			return new Response(freshFrameDocument(to), { headers });
		}

		// values with bytes past 0x7F, which Chrome would read encoded again
		browserBytes(responseHeaders, url.url, navigation);

		let body: BodyInit | undefined;
		/** the transform's output when it is a rewrite made just now */
		let rewritten: string | Blob | null = null;

		if (identityRead && !redirect) {
			// (a hop that redirects is followed by the browser, with the token)
			let text: string | null = null;
			try {
				const bytes = statusEmpty.includes(+response.status)
					? new ArrayBuffer(0)
					: await response.arrayBuffer();
				if (bytes.byteLength <= IDENTITY_READ_MAX)
					text = new TextDecoder().decode(bytes);
			} catch (error) {
				// a body that broke off: none
			}
			tellLoadClient(context!.clientId!, {
				[IDENTITY_READ]: {
					token: loadToken!,
					status: response.status,
					body: text,
				} satisfies IdentityReadMessage,
			});
			body = undefined;
			responseHeaders.delete('content-length');
		} else if (statusEmpty.includes(+response.status)) {
			body = undefined;
		} else if (opaqueFetch && !keepOpaqueBody) {
			await response.body?.cancel().catch(() => {});
			body = undefined;
		} else {
			// the page's integrity metadata (src/sri.ts), checked against the
			// origin's bytes before anything is rewritten, as the browser checks
			// them natively: a mismatch is a network error, and so is a response
			// the page could not read (another origin's without CORS), which
			// the browser cannot check at all
			if (integrity && !redirect) {
				let refusal: string | null = null;
				if (chainCrossed && policyMode === 'no-cors') {
					await response.body?.cancel().catch(() => {});
					refusal =
						'refused by its integrity: the response is not CORS enabled';
				} else {
					const bytes = new Uint8Array(await response.arrayBuffer());
					if (await integrityHolds(bytes, integrity)) {
						const checked: Response & {
							rawHeaders?: [string, string][];
						} = new Response(bytes, {
							status: response.status,
							statusText: response.statusText,
							headers: response.headers,
						});
						checked.rawHeaders = response.rawHeaders;
						response = checked;
					} else {
						refusal =
							'refused by its integrity: no digest matches the response';
					}
				}
				if (refusal !== null) {
					if (report) report = { ...report, status: 0, error: refusal };
					sendReport();
					return Response.error();
				}
			}
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
								destination: serverRequest.destination,
								mode: serverRequest.mode,
								resultingClientId: context?.resultingClientId,
								navigation,
								upgradeInsecure,
								// a frame's real ancestors (its frame-ancestors'), as told,
								// else its top as its route names it
								ancestors:
									navigation && nestedRoute !== null
										? (chain?.ancestors ?? [new URL(nestedRoute).origin])
										: null,
								requiredCSP:
									navigation && nestedRoute !== null
										? (chain?.required ?? null)
										: null,
								opener:
									navigation && topLevel
										? {
												window: destination === 'document',
												facts: chain?.coop ?? null,
											}
										: null,
								framePolicies:
									navigation && nestedRoute !== null && chain
										? chain.policies
												.map(({ policy }) => policy)
												.filter(([directive]) => directive === 'frame-src')
										: null,
								partition:
									frameSite === null || transient
										? null
										: JSON.stringify([
												topSite ?? frameSite,
												frameSite,
												credentials,
												// the site's cache mark, which a rewrite's routes
												// carry: one made before the marks were drawn
												// again is not served after
												...(siteMark ? [siteMark] : []),
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
			// bundle) and the Response has nothing left to encode. A Blob of
			// them, which the page's Response, the rewrite cache's and the
			// same document's repeat (recentOutputs) share as they are, where
			// each copied the encoded bytes again and the bytes themselves
			// were an ArrayBuffer of the worker's, kept 30 s and then left to
			// its collector, in the renderer the frames share
			// (a script's output made just now of its bytes is a Blob of them)
			if (
				typeof output === 'string' ||
				(output instanceof Blob && note.rewriteCache === 'miss')
			)
				rewritten = output;
			const encoded = typeof output === 'string' ? new Blob([output]) : null;
			const transformed = encoded ?? output;

			body =
				transformed !== false
					? transformed
					: (wholeBody(response) ?? response.body!);

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
			// the sizes the origin's body had, for the page's resource timing:
			// the browser counts the bytes it is given here (SIZE_MARKER)
			const sizes =
				serverRequest.method === 'HEAD'
					? null
					: sizeMark(
							response.headers,
							transformed !== false ? (note.bytes ?? null) : null,
							note.encodedBytes,
						);
			if (sizes !== null) responseHeaders.append('server-timing', sizes);
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
		if (memoryDestination && !siteShared) {
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

		// an image or a font goes to the page as it arrives, and is kept for
		// the same document's repeat of the request (REPEAT_DESTINATIONS):
		// one read whole is kept as it is
		if (
			recentKey !== null &&
			!transformBody &&
			body instanceof Blob &&
			response.status === 200 &&
			!previousHop
		)
			rememberOutput(recentKey, {
				body,
				status: response.status,
				statusText: response.statusText,
				headers: [...responseHeaders],
				bytes: body.size,
			});
		else if (
			recentKey !== null &&
			!transformBody &&
			body instanceof ReadableStream &&
			response.status === 200 &&
			!previousHop &&
			!(Number(responseHeaders.get('content-length')) > REPEAT_BYTES)
		) {
			const [toPage, toKeep] = body.tee();
			body = toPage;
			keepRepeat(recentKey, toKeep, {
				status: response.status,
				statusText: response.statusText,
				headers: [...responseHeaders],
			});
		}

		sendReport();
		const made = new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: responseHeaders,
		});
		if (body instanceof Blob) blobResponses.add(made);
		return made;
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
		// an XMLHttpRequest's timeout (TIMEOUT_HEADER), on this clock, which no
		// long task of the page's thread holds up: past it before the answer's
		// headers, the request is given up and the page told (by the request's
		// abort id, which no site sees)
		const timeout = abortId?.startsWith('xhr-')
			? Number(serverRequest.headers.get(TIMEOUT_HEADER)) || 0
			: 0;
		let timedOut = false;
		const timer =
			timeout > 0
				? setTimeout(() => {
						timedOut = true;
						abortRequest(abortId);
					}, timeout)
				: undefined;
		const timedOutAnswer = () =>
			new Response(null, { headers: { [TIMEOUT_HEADER]: abortId! } });
		// given up when the client that made it goes, as the browser cancels a
		// document's requests (a navigation has no client yet, a keepalive
		// request outlives its document)
		const client =
			context?.internal || serverRequest.keepalive
				? ''
				: (context?.requestClientId ?? '');
		const release = client
			? holdRequest(client, () => requestAborts.get(serverRequest)?.())
			: undefined;
		// a navigation the host may stop while it waits for its answer
		// (stopNavigation): given up as the page's abort is, answered with
		// no content
		let stopped = false;
		const navigation =
			serverRequest.mode === 'navigate'
				? withoutFragment(serverRequest.url)
				: '';
		const stop = () => {
			stopped = true;
			requestAborts.get(serverRequest)?.();
		};
		if (navigation) {
			const until = earlyStops.get(navigation);
			if (until !== undefined) {
				earlyStops.delete(navigation);
				if (Date.now() < until) {
					release?.();
					clearTimeout(timer);
					return new Response(null, { status: 204 });
				}
			}
			let stops = navigationStops.get(navigation);
			if (!stops) navigationStops.set(navigation, (stops = new Set()));
			stops.add(stop);
		}
		try {
			const answer = await forward(serverRequest, resolved, context);
			if (stopped) {
				answer.body?.cancel().catch(() => {});
				return new Response(null, { status: 204 });
			}
			if (
				navigation &&
				!timedOut &&
				navigationAnswer(
					answer.status,
					answer.headers.get('content-type'),
					answer.headers.get('content-disposition'),
				)
			)
				navigationStayed(serverRequest);
			if (!timedOut) return answer;
			answer.body?.cancel().catch(() => {});
			return timedOutAnswer();
		} catch (error) {
			if (error === ABORTED)
				return stopped
					? new Response(null, { status: 204 })
					: timedOut
						? timedOutAnswer()
						: Response.error();
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
			const page = await hostErrorPage(
				rewriter,
				{
					url: real,
					status: 502,
					error: String(error),
					kind: 'transport',
				},
				{ client: context?.clientId },
			);
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
					// the error page (the host's, or the router's own when the
					// host has none) tells the host which client it is
					client: context?.clientId,
				});
			if (page) return page;
			throw error;
		} finally {
			clearTimeout(timer);
			release?.();
			if (abortId) pendingAborts.delete(abortId);
			if (navigation) {
				const stops = navigationStops.get(navigation);
				stops?.delete(stop);
				if (stops?.size === 0) navigationStops.delete(navigation);
			}
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

const htmlMimes = ['text/html', ''];

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
const recentOutputs = new Map<string, RecentOutput & { at: number }>();
let recentBytes = 0;

/** the style sheets of another origin their clients loaded without cors (UNREPORTED_MARKER), oldest first */
const opaqueSheets = new Set<string>();
const OPAQUE_SHEETS = 2048;
const sheetKey = (clientId: string | undefined, url: string) =>
	`${clientId ?? ''}\u0000${url.split('#')[0]}`;

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
		// an image's or a font's without its fragment, which never reaches
		// the network: a stylesheet's url() is routed with one (`#url(...)`,
		// for its readback), and what it names is the same request as the
		// page's preload of it. A script's or a stylesheet's is kept: its
		// rewrite carries the URL it was asked for (a module's
		// import.meta.url, `m.js#` as well as `m.js`)
		REPEAT_DESTINATIONS.has(request.destination)
			? request.url.replace(/#.*$/s, '')
			: request.url,
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
	pendingOutputs.clear();
	recentBytes = 0;
}

/**
 * Destinations whose body goes to the page as it came, and whose repeat from
 * the same document is answered from the first response (recentOutputs):
 * natively a document takes its own preload of an image or a font, and an
 * image it loaded, whatever the response's cache headers say. Through the
 * proxy the page's markup is written by the inject (document.open and
 * write, loadHTML), and Chrome does not hand a preload fetched through a
 * service worker to a request from the other side of that write ("A preload
 * ... is not used because it is a cross-world service worker resource
 * mismatch"): a Link header's preload to an element of the markup in a
 * frame, a preload of the markup to a stylesheet's background or
 * @font-face. Each was fetched from the origin twice (Discord's background
 * image). Chrome does the same natively for a document written so; a page
 * the network parser reads has none of it. A response still arriving is
 * shared as it comes in (pendingOutputs).
 */
const REPEAT_DESTINATIONS = new Set(['image', 'font']);

/**
 * The loads whose short bodies (FINISHED_LENGTH at most, by their
 * Content-Length) are read whole, into a Blob, before the page is answered:
 * the HTTP cache, the memory cache and the document's repeat (recentOutputs)
 * keep that Blob, and the page is given it (cache.ts wholeBodies). Each
 * store read a branch of the body before, a tee per store with every chunk
 * through this thread for each, and the memory cache copied what it read
 * into a Blob of its own: a page of a hundred images was three hundred
 * streams. The browser decodes such a load only once it is whole, and the
 * stores read it whole whatever the page does already (splitForStore).
 */
const WHOLE_DESTINATIONS = new Set(['image', 'font', 'track']);

/** a 200 whose body is short by its Content-Length (WHOLE_DESTINATIONS) */
function wholeLength(response: Response): boolean {
	const length = response.headers.get('content-length');
	return (
		response.status === 200 &&
		response.body !== null &&
		length !== null &&
		/^\d+$/.test(length) &&
		Number(length) <= FINISHED_LENGTH
	);
}

/**
 * `response` with its body read whole into a Blob (wholeBodies). The Blob
 * has no type, so that the page's response gets no Content-Type it did not
 * have (an HTTP cache entry's own Blob is the browser's, read without a
 * copy, and sliced for that). A body that breaks off fails the page's read
 * of it, as before.
 */
async function wholeResponse<
	R extends Response & { rawHeaders?: [string, string][] },
>(response: R): Promise<R> {
	const init = {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	};
	let whole: R;
	try {
		const read = await response.blob();
		const blob = read.type ? read.slice(0, read.size) : read;
		whole = new Response(blob, init) as R;
		wholeBodies.set(whole, blob);
	} catch (error) {
		whole = new Response(
			new ReadableStream({
				start(controller) {
					controller.error(error);
				},
			}),
			init,
		) as R;
	}
	whole.rawHeaders = response.rawHeaders;
	return whole;
}

/** the Blob that is all of `response`'s body, while nothing has read it (wholeBodies) */
function wholeBody(response: Response): Blob | null {
	const blob = wholeBodies.get(response);
	return blob && !response.bodyUsed && !response.body?.locked ? blob : null;
}
/** a larger body is not kept for a repeat */
const REPEAT_BYTES = 16 * 1024 * 1024;
/** a repeatable response the worker is still reading, by recentOutputKey */
const pendingOutputs = new Map<string, Promise<RecentOutput | null>>();

/** read `stream` (a branch of the page's body) and keep it under `key`, unless it is larger than REPEAT_BYTES or fails */
function keepRepeat(
	key: string,
	stream: ReadableStream<Uint8Array>,
	response: Omit<RecentOutput, 'body' | 'bytes'>,
) {
	const read = async (): Promise<RecentOutput | null> => {
		const reader = stream.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > REPEAT_BYTES) {
					await reader.cancel().catch(() => {});
					return null;
				}
				chunks.push(value);
			}
		} catch (error) {
			return null;
		}
		const body = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			body.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const output = { ...response, body, bytes: size };
		rememberOutput(key, output);
		return output;
	};
	const pending: Promise<RecentOutput | null> = read().finally(() => {
		if (pendingOutputs.get(key) === pending) pendingOutputs.delete(key);
	});
	pendingOutputs.set(key, pending);
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
const OWN_MARKS = [TAO_MARKER, OPAQUE_MARKER, AWAY_MARKER];

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
	// (the sizes of the origin's body are the bytes', whatever load they
	// answer; two responses are not compared by them either)
	const sizes = (headers.get('server-timing') ?? '')
		.split(',')
		.map((metric) => metric.trim())
		.find((metric) => metric.startsWith(`${SIZE_MARKER};`));
	if (sizes) out.append('server-timing', sizes);
	out.append('server-timing', KEPT_MARKER);
	return out;
}

/**
 * The origin's Server-Timing metrics with every name that starts with
 * `stomp-` (as the worker's marks do) made `stomp-!<rest>`, which the
 * inject reads back (siteMetrics in messages.ts); a quoted description's
 * text is left as it is
 */
function escapeSiteMetrics(headers: Headers) {
	const value = headers.get('server-timing');
	if (value?.includes('stomp-'))
		headers.set(
			'server-timing',
			value.replace(
				/("(?:[^"\\]|\\.)*")|((?:^|,)\s*stomp-)/g,
				(all, quoted, start) => quoted ?? `${start}!`,
			),
		);
}

/** whether a Server-Timing value has the worker's mark `mark` */
const hasMark = (value: string | null, mark: string) =>
	!!value?.split(',').some((metric) => metric.split(';')[0].trim() === mark);

/**
 * The Server-Timing metric that tells the inject the sizes the origin's
 * body had (SIZE_MARKER), or null when the browser's own count of the
 * answer is the origin's already. `headers` are the origin's and `read` the
 * bytes of the body a transform read (null for a body passed through).
 * A body that came encoded was as long as the transport counted before it
 * decoded it (`counted`, read once the body has ended: responseFacts.ts),
 * else as its Content-Length says; with neither (a chunked answer through
 * a transport that does not count) it counts as its decoded bytes. A body
 * passed through goes before its end, and only its Content-Length says.
 */
function sizeMark(
	headers: Headers,
	read: number | null,
	counted?: EncodedBytes,
): string | null {
	if (read === null) {
		const told = encodedLength(headers);
		return told !== null ? `${SIZE_MARKER};dur=${told}` : null;
	}
	const [encoded, decoded] = documentSizes(headers, read, counted);
	return `${SIZE_MARKER};dur=${encoded};desc=${decoded}`;
}

/** whether a body came with a Content-Encoding */
function isEncoded(headers: Headers): boolean {
	const encoding = (headers.get('content-encoding') ?? '').trim().toLowerCase();
	return encoding !== '' && encoding !== 'identity';
}

/** how long an encoded body was by its Content-Length, or null when it came as it is or nothing says */
function encodedLength(headers: Headers): number | null {
	const encoded = isEncoded(headers);
	const told = headers.get('content-length');
	const length =
		told !== null && /^\d+$/.test(told.trim()) ? Number(told.trim()) : null;
	return encoded ? length : null;
}

/** the sizes a body of `read` decoded bytes had: [encoded, decoded] (sizeMark) */
function documentSizes(
	headers: Headers,
	read: number,
	counted?: EncodedBytes,
): [number, number] {
	const before = isEncoded(headers) ? counted?.() : undefined;
	return [before ?? encodedLength(headers) ?? read, read];
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
	// the browser selects a parser by the MIME essence, which it lowercases
	// and trims (Fetch "extract a MIME type"): a document served `Text/HTML`
	// or ` text/html ` is parsed as HTML, so the shell must stand in for it,
	// or its scripts run unrewritten on the proxy origin
	return contentType.split(';')[0].trim().toLowerCase();
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

/**
 * how long a navigation whose response changed the jar waits for the
 * windows to be told (changesTold): a bound, the posts take a few ms
 */
const CHANGE_TOLD_MS = 250;

/** the route of a document (src/rewriteHTML.ts routeHTML) */
const DOCUMENT_ROUTE = /^\/html(:nested:[^/]*)?\//;

/** an HTML document's first part, read until its encoding and its head are known (readHead) */
interface HeadRead {
	encoding: string;
	/** the markup so far */
	text: string;
	/** how many bytes of the body that was */
	bytes: number;
	/** the body's reader, with more to come; null when that was all */
	rest: ReadableStreamDefaultReader<Uint8Array> | null;
	/** the rest's first read, made already */
	next: Promise<ReadableStreamReadResult<Uint8Array>> | null;
	decoder: TextDecoder;
	/** whether the head has ended (or the body): not when readHead's deadline came first */
	head: boolean;
}

/** the bytes the encoding is decided by: a byte order mark and the prescan's (src/server/charset.ts) */
const PRESCAN_BYTES = 1024;
/** where the body starts: what the head's metas are read up to (metaPolicies) */
const BODY_START = /<body[\s>]/i;

/**
 * Read an HTML document's body until its encoding is decided (its first
 * 1024 bytes) and its head has ended (`<body`, which the meta readers stop
 * at), or to its end. The decode is the whole body's (a decoder fed as the
 * bytes come gives the same text). A head that pauses for `headGap` ms
 * after the first 1024 bytes, or has not ended `headCap` ms after them, is
 * left where it got to (`head` says so).
 */
async function readHead(
	response: Response,
	contentType: string | null,
	headGap = Infinity,
	headCap = Infinity,
): Promise<HeadRead | null> {
	if (!response.body) return null;
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	let done = false;
	while (bytes < PRESCAN_BYTES) {
		const chunk = await reader.read();
		if (chunk.done) {
			done = true;
			break;
		}
		chunks.push(chunk.value);
		bytes += chunk.value.byteLength;
	}
	const first = new Uint8Array(bytes);
	let at = 0;
	for (const chunk of chunks) {
		first.set(chunk, at);
		at += chunk.byteLength;
	}
	const encoding = documentEncoding(first, contentType);
	const decoder = new TextDecoder(encoding);
	let text = decoder.decode(first, { stream: !done });
	// each new piece is searched with the end of the text before it (`<body`
	// may be split between pieces), never the whole text: a slice of a text
	// that grows a piece at a time flattens it each time, quadratic over a
	// head of megabytes (0.4 s for CNN's 3.5 MB head)
	let piece = text;
	let carry = '';
	const deadline = Date.now() + headCap;
	while (!done && !BODY_START.test(carry + piece)) {
		carry = (carry + piece).slice(-5);
		const pending = reader.read();
		const chunk =
			headGap === Infinity
				? await pending
				: await valueWithin(pending, Math.min(headGap, deadline - Date.now()));
		if (chunk === null)
			return {
				encoding,
				text,
				bytes,
				rest: reader,
				next: pending,
				decoder,
				head: false,
			};
		if (chunk.done) {
			done = true;
			text += decoder.decode();
			break;
		}
		bytes += chunk.value.byteLength;
		piece = decoder.decode(chunk.value, { stream: true });
		text += piece;
	}
	// what comes at once is read too: a document that is all there (most
	// are) goes in its shell, as it always did, and is not worth a second
	// request; one that keeps coming, or pauses, streams
	let next: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
	while (!done && bytes < WHOLE_BYTES) {
		next = reader.read();
		const chunk = await Promise.race([
			next,
			new Promise<null>((resolve) => setTimeout(() => resolve(null), QUICK_MS)),
		]);
		if (chunk === null) break;
		next = null;
		if (chunk.done) {
			done = true;
			text += decoder.decode();
			break;
		}
		bytes += chunk.value.byteLength;
		text += decoder.decode(chunk.value, { stream: true });
	}
	return {
		encoding,
		text,
		bytes,
		rest: done ? null : reader,
		next,
		decoder,
		head: true,
	};
}
/** `promise`'s value, or null if it has none within `ms` */
function valueWithin<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout>;
	return Promise.race([
		promise,
		new Promise<null>((resolve) => (timer = setTimeout(resolve, ms, null))),
	]).finally(() => clearTimeout(timer));
}
/**
 * How long a document's head may pause, and how long it may take, after its
 * first 1024 bytes before its shell goes out without it: the browser
 * commits a document on its first bytes, and YouTube's head (790 KB of it
 * at once, then a pause before its last 17 KB) held the commit 450 ms. A
 * head that keeps coming (CNN's 3.2 MB) is read on, and goes in one piece
 */
const HEAD_GAP_MS = 20;
const HEAD_CAP_MS = 100;
/** a document of at most this much that arrives at once is not streamed (readHead) */
const WHOLE_BYTES = 256 * 1024;
/** what "at once" is: the next chunk within this */
const QUICK_MS = 20;

/**
 * What a meta of a later piece of a head said (streamMarkup's `told`), for
 * the client to apply before it writes the piece: the page's script facts
 * as its policies now make them, and that its requests are upgraded
 */
interface HeadTold {
	facts: Pick<ScriptFacts, 'code' | 'ttActive' | 'rtt'>;
	upgrade?: true;
}

/** a document's markup streams the worker holds for their clients, by token (MARKUP_ROUTE) */
const markupStreams = new Map<
	string,
	{ stream: ReadableStream<Uint8Array>; timer: ReturnType<typeof setTimeout> }
>();
/** how long a markup stream waits for its client before it goes */
const MARKUP_WAIT_MS = 60_000;
/** a raw text element's start tag at the start of a piece (pageStream's RAW_TEXT) */
const RAW_START =
	/^<(script|style|title|textarea|xmp|iframe|noembed|noframes)(?=[\s/>])[^>]*>/i;
/** a piece of markup is cut once this much is in hand, or after SEGMENT_MS */
const SEGMENT_CHARS = 32 * 1024;
const SEGMENT_MS = 30;
/** how long a cut of a document's markup waits for its page to take its records, at most (the page may be busy) */
const ROOM_WAIT_MS = 50;
/** the slices a record is queued in */
const SLICE_BYTES = 256 * 1024;
/** how long a document's markup is read at a stretch before this thread's other tasks run */
const READ_SLICE_MS = 5;
/** a task of its own: what is queued before it (a rewrite worker's answer) runs first */
const nextTask = () =>
	new Promise<void>((resolve) => {
		const channel = new MessageChannel();
		channel.port1.onmessage = () => {
			channel.port1.close();
			resolve();
		};
		channel.port2.postMessage(null);
	});

const TOKEN_ALPHABET =
	'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * The rest of a document's markup, for its client as it arrives
 * (MARKUP_ROUTE): `first`, the markup read so far (with what the worker
 * added to it), then the body as `read`'s reader gives it, in pieces cut
 * between whole tokens (never inside a script's or a style's text), each
 * with the prewritten table of its inline scripts and styles (`prewrite`)
 * and `meta` shown each later piece; the last piece carries the sizes the
 * body had (`sizes`, of its decoded byte count: [encoded, decoded]). Answers
 * the token the client asks with.
 */
function streamMarkup(
	read: HeadRead,
	first: string,
	/** `at`: where the piece starts in the document (the lines before, the column) */
	prewrite: (
		segment: string,
		at: [number, number],
	) => {
		finish: () => Promise<Prewritten>;
	} | null,
	meta: ((segment: string) => void) | null,
	sizes: (read: number) => [number, number],
	client: string | undefined,
	/**
	 * a head still coming when the shell went out: shown each later piece
	 * until the body starts, and what it answers goes with the piece
	 * (HeadTold)
	 */
	told: ((segment: string) => HeadTold | null) | null = null,
): string {
	const random = new Uint8Array(22);
	crypto.getRandomValues(random);
	let token = '';
	for (const byte of random) token += TOKEN_ALPHABET[byte & 63];
	const reader = read.rest!;
	const decoder = read.decoder;
	const encoder = new TextEncoder();
	let total = read.bytes;
	// a cut of the body waits (ROOM_WAIT_MS at most) while the page has
	// records to take (`room`, which the stream's pull calls once it took
	// them): it takes them as this thread hands them on, a task at a time,
	// and a piece cut meanwhile (CNN's 2.46 MB inline script, tasks of 10 to
	// 25 ms) held back the head before it (6.6 MB, 110 ms to the page,
	// measured). The stream is in order: nothing behind would go out sooner
	let room: (() => void) | null = null;
	let gone = false;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let order = Promise.resolve();
			// a <base>: the worker's outputs would be for another URL
			let based = false;
			let later = false;
			let head = told !== null && !BODY_START.test(first);
			// where the next piece starts in the document: the lines before
			// (line feeds) and its column
			const at: [number, number] = [0, 0];
			const send = (segment: string, end: boolean) => {
				let said: HeadTold | null = null;
				if (later) {
					meta?.(segment);
					if (head) {
						said = told!(segment);
						if (BODY_START.test(segment)) head = false;
					}
				}
				later = true;
				if (!based && hasBase(segment)) based = true;
				const job = based ? null : prewrite(segment, [at[0], at[1]]);
				const last = segment.lastIndexOf('\n');
				if (last < 0) at[1] += segment.length;
				else {
					for (
						let i = segment.indexOf('\n');
						i >= 0;
						i = segment.indexOf('\n', i + 1)
					)
						at[0]++;
					at[1] = segment.length - last - 1;
				}
				order = order.then(async () => {
					let table: Prewritten | null = null;
					if (job)
						try {
							table = await job.finish();
						} catch (error) {
							console.warn('Stomp: no prewritten table:', error);
						}
					// a task of its own: the record of a large piece (CNN's 2.46 MB
					// inline script, 55 ms) held back what the page waits for
					// meanwhile (its storage, through the synchronous bridge)
					await nextTask();
					const record = JSON.stringify([
						segment,
						table,
						end ? sizes(total) : null,
						...(said ? [said] : []),
					]);
					try {
						const bytes = encoder.encode(`${record.length}\n${record}`);
						// (in slices: what the page has not taken is what is queued)
						for (let from = 0; from < bytes.length; from += SLICE_BYTES)
							controller.enqueue(bytes.subarray(from, from + SLICE_BYTES));
						if (end) controller.close();
					} catch (error) {
						// the page went away
					}
				});
			};
			let pending = first;
			// a cut is tried once this much is in hand (twice what a cut that
			// found no whole token had: a script's text may be megabytes)
			let tryAt = 0;
			// or, where the cut found a raw text element's text unfinished
			// (YouTube's 780 KB inline script, with its head still coming),
			// once its end tag is in what came since: doubling alone could
			// pass the document's end, and its rest waited for the last byte
			let rawEnd: RegExp | null = null;
			let searched = 0;
			let last = Date.now();
			// what came since the last cut, when the origin pauses: cut then
			let timer: ReturnType<typeof setTimeout> | null = null;
			// a cut put off while the page has records to take (`room`)
			let held: ReturnType<typeof setTimeout> | null = null;
			const cut = (waited = false) => {
				if (timer !== null) clearTimeout(timer);
				timer = null;
				if (!waited && !gone && (controller.desiredSize ?? 1) <= 0) {
					if (held === null) {
						const go = () => {
							clearTimeout(held!);
							held = null;
							room = null;
							if (pending.length >= tryAt) cut(true);
						};
						room = go;
						held = setTimeout(go, ROOM_WAIT_MS);
					}
					return;
				}
				if (held !== null) clearTimeout(held);
				held = null;
				room = null;
				let end = completeLength(pending);
				// (never between the halves of a surrogate pair)
				const unit = pending.charCodeAt(end - 1);
				if (unit >= 0xd800 && unit < 0xdc00) end--;
				if (end === 0) {
					const raw = RAW_START.exec(pending);
					if (raw) {
						if (rawEnd === null) searched = raw[0].length;
						rawEnd = new RegExp(`</${raw[1]}`, 'gi');
						tryAt = Infinity;
					} else {
						rawEnd = null;
						tryAt = pending.length * 2;
					}
					return;
				}
				send(pending.slice(0, end), false);
				pending = pending.slice(end);
				tryAt = 0;
				rawEnd = null;
				last = Date.now();
			};
			// after the shell is on its way, and after the page asked for its
			// inject bundle (or BUNDLE_WAIT_MS): the first piece is the whole
			// head, whose cut and prewrite (CNN's 3.7 MB) held the shell back,
			// and the bundle's fetch event waited for this thread to be done
			// with them (190 ms on CNN), where the page could load it while
			// the head is rewritten
			bundleAsked(client).then(() => {
				cut();
				void readRest();
			});
			const readRest = async () => {
				// the last characters of what came (an end tag may be split
				// between the chunks): an unfinished raw text element's end tag
				// is looked for in them and the chunk alone. A search of
				// `pending` flattened it each chunk, quadratic over CNN's 2.46 MB
				// inline script (70 ms of this thread, measured)
				let tail = '';
				// when this thread last let its other tasks run
				let slice = performance.now();
				try {
					for (let next = read.next; ; next = null) {
						// a body that came at once is read in microtasks, which held
						// back the rewrite workers' answers (CNN's head's table went
						// out 160 ms after its scripts were rewritten, measured): they
						// run every READ_SLICE_MS
						if (performance.now() - slice >= READ_SLICE_MS) {
							await nextTask();
							slice = performance.now();
						}
						const asked = performance.now();
						const chunk = await (next ?? reader.read());
						if (chunk.done) break;
						// (a read that waited let them run)
						if (performance.now() - asked > 1) slice = performance.now();
						total += chunk.value.byteLength;
						const text = decoder.decode(chunk.value, { stream: true });
						const before = pending.length;
						pending += text;
						if (rawEnd !== null) {
							// (once after a cut, the text before the chunk is searched)
							const back = before - searched;
							const hay =
								back <= tail.length
									? tail.slice(tail.length - back) + text
									: pending.slice(searched);
							rawEnd.lastIndex = 0;
							const found = rawEnd.exec(hay);
							tail = (tail + text).slice(-16);
							if (!found) {
								searched = Math.max(searched, pending.length - 16);
								continue;
							}
							searched += found.index + 1;
							tryAt = 0;
						} else tail = (tail + text).slice(-16);
						if (pending.length < tryAt) continue;
						if (
							pending.length >= SEGMENT_CHARS ||
							Date.now() - last >= SEGMENT_MS
						)
							cut();
						else
							timer ??= setTimeout(() => {
								timer = null;
								if (pending.length >= tryAt) cut();
							}, SEGMENT_MS);
					}
					pending += decoder.decode();
				} catch (error) {
					// the body failed: what came is the page, as the browser's
					// parser would have it
				}
				if (timer !== null) clearTimeout(timer);
				if (held !== null) clearTimeout(held);
				room = null;
				send(pending, true);
			};
		},
		pull() {
			room?.();
		},
		cancel() {
			gone = true;
			reader.cancel().catch(() => {});
		},
	});
	markupStreams.set(token, {
		stream,
		timer: setTimeout(() => {
			if (markupStreams.get(token)?.stream !== stream) return;
			markupStreams.delete(token);
			stream.cancel().catch(() => {});
		}, MARKUP_WAIT_MS),
	});
	return token;
}
/** the documents whose bundle request is awaited (bundleAsked), by client id */
const bundleWaits = new Map<string, () => void>();
/** how long a document's head waits for its bundle request (one the memory cache answers comes to no worker) */
const BUNDLE_WAIT_MS = 40;
function bundleAsked(client: string | undefined): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(done, client ? BUNDLE_WAIT_MS : 0);
		function done() {
			clearTimeout(timer);
			if (client && bundleWaits.get(client) === done)
				bundleWaits.delete(client);
			resolve();
		}
		if (client) bundleWaits.set(client, done);
	});
}
/** the document `client` asked for its inject bundle (src/server/serviceWorker.ts documentBundle) */
export function bundleRequested(client: string) {
	bundleWaits.get(client)?.();
}
/** a page's blob: script or stylesheet (src/inject/modules/ObjectURL.ts): its kind, and the private URL's uuid */
const BLOB_ROUTE = /^\/blob~(js|wjs|module|css)(?:~([\da-f-]{36}))?\//;
/**
 * the bytes of the Blob behind a blob: URL (its uuid) or an inline
 * document's (its token), which a realm that holds it hands over
 * (src/inject/modules/ObjectURL.ts)
 */
const BLOB_BYTES_ROUTE = /^\/blob~bytes\/([\da-f-]{36}|[A-Za-z0-9_-]{22})$/;

/**
 * The bytes of the Blobs behind private URLs (BLOB_ROUTE), as the realms
 * that hold them handed them over, by the URL's uuid, with the real origin
 * of the realm that did. In a frame of another site's page Firefox and
 * WebKit refuse this worker's fetch() of a blob: URL the frame minted, and
 * WebKit's worker cannot read a Blob posted to it there either (NotFoundError);
 * the body of the frame's own request is read (measured, Firefox 157 and
 * WebKitGTK 2.52.4). Kept while there is room (HANDED_BYTES, the oldest go
 * first), as the private URL is: every load of it reads them.
 */
const handedBlobs = new Map<
	string,
	{ origin: string; type: string; bytes: ArrayBuffer }
>();
const HANDED_BYTES = 64 * 1024 * 1024;
let handedSize = 0;
/** the loads waiting for bytes not handed over yet */
const handedWaits = new Map<string, (() => void)[]>();
/** the header of a realm's answer to BLOB_ASK: `bytes`, or `none` (with no body) */
const BLOB_ANSWER_HEADER = 'stomp-blob-answer';
/** how long a load whose blob: URL this worker cannot read waits for them */
const HANDED_WAIT_MS = 3000;
/**
 * whether this worker reads its clients' blob: URLs itself, as it learns
 * from a blob: URL a controller's document mints for it (learnBlobsReadable),
 * else at the first bytes handed over: then it needs none (the realm that
 * offers them is told so, and offers no more), and asks for none
 */
let blobsReadable: boolean | undefined;
/** asks a controller's document for a blob: URL it minted (registerRewrites) */
let askBlobURL: (() => Promise<string | null>) | undefined;
let learningBlobs: Promise<void> | undefined;
/** how long learnBlobsReadable waits for the controller's document */
const BLOB_LEARN_MS = 1000;
/**
 * Learn blobsReadable from a blob: URL a controller's document minted for
 * this worker, once, as the first load of a page's Blob comes, before it
 * asks a realm for any bytes: a load then never waits on an ask where this
 * worker reads blob: URLs itself (Chrome, whose dedicated workers hear no
 * ask and left an import of a revoked blob: URL waiting HANDED_WAIT_MS; a
 * first-party page anywhere). The worker cannot mint one itself (no
 * URL.createObjectURL in a service worker). A controller that does not
 * answer in time is not asked again (the next one that connects is), so a
 * load waits for it at most once
 */
function learnBlobsReadable(): Promise<void> {
	if (blobsReadable !== undefined || !askBlobURL) return Promise.resolve();
	const ask = askBlobURL;
	learningBlobs ??= Promise.race([
		Promise.resolve().then(ask),
		new Promise<null>((resolve) =>
			setTimeout(() => resolve(null), BLOB_LEARN_MS),
		),
	])
		.catch(() => null)
		.then(async (url) => {
			if (
				blobsReadable === undefined &&
				typeof url === 'string' &&
				url.startsWith(`blob:${location.origin}/`)
			)
				try {
					await (await fetch(url)).body?.cancel();
					blobsReadable = true;
				} catch (error) {
					blobsReadable = false;
				}
			else if (askBlobURL === ask) askBlobURL = undefined;
			learningBlobs = undefined;
		});
	return learningBlobs;
}

function handBlob(
	uuid: string,
	handed: { origin: string; type: string; bytes: ArrayBuffer },
) {
	const before = handedBlobs.get(uuid);
	if (before) handedSize -= before.bytes.byteLength;
	handedBlobs.delete(uuid);
	handedBlobs.set(uuid, handed);
	handedSize += handed.bytes.byteLength;
	for (const [old, { bytes }] of handedBlobs) {
		if (handedSize <= HANDED_BYTES || old === uuid) break;
		handedBlobs.delete(old);
		handedSize -= bytes.byteLength;
	}
	for (const wake of handedWaits.get(uuid) ?? []) wake();
	handedWaits.delete(uuid);
}

/**
 * The bytes of the Blob behind `url` (the browser's form), asked of the
 * first live client of `asked` that may hold it (its minter, else the realm
 * that loads it: BLOB_ASK) when no realm handed them over, and waited for a
 * while. A window and a worker both answer, in Firefox and WebKit
 * (measured); one that holds no such Blob (the page revoked it) says so,
 * and the load fails at once, as natively. Not asked where this worker
 * reads its clients' blob: URLs: there the URL is gone
 */
async function askedBlob(url: string, ...asked: (string | null | undefined)[]) {
	const uuid = url.slice(url.lastIndexOf('/') + 1);
	await learnBlobsReadable();
	if (blobsReadable) return undefined;
	if (handedBlobs.has(uuid) || typeof clients === 'undefined')
		return handedBlobs.get(uuid);
	for (const id of asked) {
		const client = id
			? await clients.get(id).catch(() => undefined)
			: undefined;
		if (!client) continue;
		client.postMessage({ [BLOB_ASK]: url });
		return handedBlob(uuid);
	}
	return undefined;
}

/** the bytes handed over for `uuid`, waited for a while when they have not come yet */
async function handedBlob(uuid: string) {
	if (!handedBlobs.has(uuid))
		await new Promise<void>((resolve) => {
			const waits = handedWaits.get(uuid) ?? [];
			waits.push(resolve);
			handedWaits.set(uuid, waits);
			setTimeout(resolve, HANDED_WAIT_MS);
		});
	return handedBlobs.get(uuid);
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
	blocker?: BlockerLike,
	blockerAsked = true,
	shields?: ShieldsStore,
	storage?: StorageHosts,
	/** asks the controller's document what the browser makes of cross-origin isolation (null: it cannot say) */
	askIsolationEngine?: () => Promise<IsolationEngine | null>,
	/** asks the controller's document for a blob: URL it minted (learnBlobsReadable) */
	askBlobProbe?: () => Promise<string | null>,
	tellIsolationWanted?: (client: string) => void,
	tellApartServed?: () => void,
	/** the extensions' declarativeNetRequest rules */
	dnr?: DnrHost,
	/** the scope's extensions (docs/extensions.md) */
	extensions?: ExtensionRegistry,
	/** a slot of the site pool: the hub's worker's extensions (./remoteExtensions.ts) */
	remoteExtensions?: RemoteExtensions,
) {
	const pipeline = extensions
		? new ExtensionPipeline(extensions, init.directory)
		: undefined;
	// (the newest controller's: an older one may be gone)
	if (askBlobProbe) askBlobURL = askBlobProbe;
	let isolationEngine: Promise<IsolationEngine> | undefined;
	const rewriter: Rewriter = {
		get config() {
			return {
				directory: this.directory,
				scope: init.scope,
				// whose stores the pages' native ones are (src/profile.ts)
				...(init.profile ? { profile: init.profile } : {}),
				codec: codecType(this.codec),
				frameAncestors: init.frameAncestors,
				...(init.openTab ? { openTab: true } : {}),
				// the host's page is cross-origin isolated: a document says whom
				// it embeds (src/isolation.ts)
				...(init.isolated ? { isolated: true } : {}),
				// the pages' synchronous requests complete (a written script in
				// a document no worker controls is copied at once)
				...(init.workerTransport ? { workerTransport: true } : {}),
				// whether a page's synchronous request reaches the worker
				// (./Sync.ts reached)
				...(syncAnswers() !== undefined ? { syncAnswers: syncAnswers() } : {}),
				// a page that waits synchronously stops this worker
				// (./syncFrozen.ts)
				...(syncFrozen() ? { syncFrozen: true } : {}),
				// its origin is a file: page's (offline.html)
				...(globalThis.location?.protocol === 'file:'
					? { fileRoutes: true }
					: {}),
				...(init.allowInvalidJs === false ? { allowInvalidJs: false } : {}),
				// every document's inject builds the window membrane from this
				...(init.membrane === false ? { membrane: false } : {}),
				// the host holds passkeys: a page's WebAuthn requests go to it
				...(init.passkeys ? { passkeys: init.passkeys } : {}),
				// pages get emulated service workers (docs/service-workers.md)
				...(init.serviceWorkers === false ? { serviceWorkers: false } : {}),
				// the rewriter is the wasm core module (the only one)
				rewriter: 'wasm' as const,
				...(init.assets ? { assets: init.assets } : {}),
				// the blocker is on: every document's inject takes its natives
				// for the cosmetic rules before it hooks anything
				...(init.adblock ? { adblock: true } : {}),
				// the deployment's helper names: the shell and every rewritten
				// script use them, and the inject reads them from this config
				...(init.names ? { names: init.names } : {}),
				// the host's hooks: every shell and worker preamble runs them
				...(init.hooks ? { hooks: init.hooks } : {}),
				// the site pool: the page's history steps into another slot's
				// documents natively
				...(init.sites ? { sites: init.sites } : {}),
				// the hub of a site pool: its slots (src/routeURL.ts proxyOrigins)
				...(init.slotOrigins ? { slotOrigins: init.slotOrigins } : {}),
				build: BUILD,
			};
		},
		cookies,
		cache,
		rewrites,
		pool,
		// the host's request log, and the extensions' onCompleted and
		// onErrorOccurred (nothing is built while neither listens)
		get log() {
			if (!pipeline?.logs) return log;
			return (info: RequestInfo) => {
				log?.(info);
				pipeline.logged(info);
			};
		},
		rules: [],
		blocker,
		extensions,
		remoteExtensions,
		pipeline,
		blockerAsked,
		shields,
		dnr,
		storage,
		isolated: !!init.isolated,
		isolationWanted: tellIsolationWanted,
		apartServed: tellApartServed,
		// kept once the controller said; asked again after a failure, by
		// Chrome's rules meanwhile
		isolationEngine() {
			isolationEngine ??= Promise.race([
				askIsolationEngine?.() ?? Promise.resolve(null),
				new Promise<null>((resolve) =>
					setTimeout(() => resolve(null), ISOLATION_ENGINE_WAIT_MS),
				),
			])
				.catch(() => null)
				.then((engine) => {
					if (engine) return engine;
					isolationEngine = undefined;
					return CHROMIUM;
				});
			return isolationEngine;
		},
		codec: init.codec,
		directory: init.directory,
		errorPage: init.errorPage,
		names: init.names,
		// (what the transport says of each answer is noted: responseFacts.ts)
		bare: new BareCompatibleClient(notingFacts(transport)),
	};

	// the extensions' routes (docs/extensions.md): their content scripts'
	// functions, and their contexts' calls
	// the requesting document's real origin, by its client
	const clientOrigin = async (id: string | undefined) => {
		if (!id) return null;
		const known = clientURLs.get(id);
		if (known) return known.origin;
		const found = typeof clients !== 'undefined' ? await clients.get(id) : null;
		if (!found) return null;
		try {
			return parseRoutedURL(
				found.url,
				rewriter.codec,
				`${new URL(found.url).origin}${rewriter.directory}`,
			).url.url.origin;
		} catch (error) {
			// a client at no routed URL names no origin
			return null;
		}
	};
	const rewriteContentScript = (source: string, file: string) =>
		modifyJS(
			source,
			new StompURL(file, rewriter.codec, rewriter.directory),
			rewriter.config,
			'generic',
		);
	const rewriteStylesheet = (css: string, file: string) =>
		modifyCSS(css, new StompURL(file, rewriter.codec, rewriter.directory));
	const realURL = (routed: string) => {
		try {
			return parseRoutedURL(
				routed,
				rewriter.codec,
				`${new URL(routed).origin}${rewriter.directory}`,
			).url.toString();
		} catch (error) {
			return routed;
		}
	};
	if (remoteExtensions) {
		// a slot of the site pool: its documents' content scripts and their
		// calls are the hub's worker's, which this worker only carries
		router.routes.set(
			new RegExp(`^/${CONTENT_SCRIPT_ROUTE}/`),
			async (request, _path, context) =>
				remoteExtensions.script(request, await clientOrigin(context?.clientId)),
		);
		router.routes.set(
			new RegExp(`^/${EXTENSION_API_ROUTE}$`),
			(request, _path, context) =>
				remoteExtensions.api(request, context?.clientId),
		);
	} else if (extensions) {
		router.routes.set(
			new RegExp(`^/${CONTENT_SCRIPT_ROUTE}/`),
			(request, path, context) =>
				contentScriptResponse(
					extensions,
					request,
					path,
					rewriteContentScript,
					() => clientOrigin(context?.clientId),
				),
		);
		router.routes.set(
			new RegExp(`^/${EXTENSION_API_ROUTE}$`),
			(request, _path, context) =>
				extensionApi(
					extensions,
					request,
					context?.clientId,
					rewriter.directory,
					realURL,
					rewriteContentScript,
					rewriteStylesheet,
				),
		);
	}
	/**
	 * What this worker answers the slots' workers of its site pool with
	 * (./remoteExtensions.ts): what it would answer a document of its own.
	 * A route is taken on this worker's origin, where its injections are kept
	 */
	const served = async (response: Response): Promise<ServedResponse> => ({
		status: response.status,
		type: response.headers.get('content-type') ?? 'text/javascript',
		cache: response.headers.get('cache-control'),
		body: await response.text(),
	});
	const extensionsServe: ExtensionsServe | undefined = extensions
		? {
				any: () => extensions.any,
				ready: () => extensions.ready(),
				onChange: (listener) => extensions.onChange(listener),
				shell: async (doc, runtime, access) =>
					// (the Web Store's pages are each worker's own: storeCall
					// reads the page's client, which only its worker has)
					isStoreURL(doc.url)
						? null
						: ((
								await documentShell(extensions, doc, {
									runtime,
									access,
									rewriteCSS: rewriteStylesheet,
								})
							)?.parts ?? null),
				script: async (url, origin) => {
					const at = new URL(url);
					const here = new URL(`${at.pathname}${at.search}`, location.origin);
					if (!here.pathname.startsWith(rewriter.directory))
						return served(new Response(null, { status: 404 }));
					return served(
						await contentScriptResponse(
							extensions,
							new Request(here),
							here.pathname.slice(rewriter.directory.length - 1),
							rewriteContentScript,
							async () => origin,
						),
					);
				},
				api: async (body, client) =>
					served(
						await extensionApi(
							extensions,
							new Request(
								new URL(
									`${rewriter.directory}${EXTENSION_API_ROUTE}`,
									location.origin,
								),
								{
									method: 'POST',
									headers: { 'content-type': 'application/json' },
									body,
								},
							),
							client,
							rewriter.directory,
							realURL,
							rewriteContentScript,
							rewriteStylesheet,
						),
					),
			}
		: undefined;

	// binary:set is a srcset candidate (routeImageSet), loaded the same way.
	// A file's route hands on the body as the site sent it: a frame that
	// navigates to one (an SVG animation's value, routed as a file before
	// its target was known, reaching a link) would show markup as written,
	// its scripts running unrewritten on the proxy's origin. Such a
	// navigation goes on to the document's own address, as a link's does
	const files = genericForward(
		rewriter,
		undefined,
		(resource) => routeBinary(resource),
		undefined,
		undefined,
	);
	router.routes.set(
		/^\/binary(?::set)?\//,
		(serverRequest, resolved, context) => {
			if (
				serverRequest.mode !== 'navigate' ||
				!DOCUMENT_DESTINATIONS.has(serverRequest.destination)
			)
				return files(serverRequest, resolved, context);
			const oURL = new URL(serverRequest.url);
			const { url } = parseRoutedURL(
				serverRequest.url,
				rewriter.codec,
				`${oURL.origin}${rewriter.directory}`,
			);
			return new Response(undefined, {
				headers: { location: formLocation(serverRequest, oURL, url) },
				status: 307,
			});
		},
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
		preamble = '',
	): Promise<string> => {
		const told: RewrittenBy = {};
		const pooled = rewriter.pool?.live
			? await rewriter.pool.rewrite(
					text,
					url,
					rewriter.config,
					type,
					told,
					preamble,
				)
			: null;
		note.rewriteIn = pooled === null ? 'service-worker' : 'pool';
		const output =
			pooled ??
			modifyJS(text, url, rewriter.config, type, preamble, SCRIPT_FILE, told);
		// the wasm module made it (the only rewriter), or it was handed back
		// where no shipped syntax could be rewritten
		note.rewriteBy = told.by ?? 'wasm';
		return output;
	};
	// a script that came as UTF-8 goes to the rewriter as its bytes, and its
	// output comes back as a Blob of its bytes (src/wasm/rewriteBytes.ts),
	// from a rewrite worker or this thread: the same output rewriteScript
	// makes of the text they decode to, never decoded or encoded here. Its
	// text where it was made of the decoded text (a script the module does
	// not answer for). The bytes are handed to the worker, and had again
	// of `body` when it does not answer
	const rewriteScriptBytes = async (
		body: BodyBytes,
		url: StompURL,
		type: ScriptType,
		note: Note,
		preamble = '',
	): Promise<Blob | string> => {
		const pooled = rewriter.pool?.live
			? await rewriter.pool.rewriteBytes(
					body,
					url,
					rewriter.config,
					type,
					preamble,
				)
			: null;
		note.rewriteIn = pooled === null ? 'service-worker' : 'pool';
		note.rewriteBy = 'wasm';
		if (pooled !== null) return pooled;
		const bytes = body.bytes;
		return (
			rewriteBytesInWasm(bytes, url, rewriter.config, type, preamble) ??
			modifyJS(
				new TextDecoder().decode(bytes),
				url,
				rewriter.config,
				type,
				preamble,
				SCRIPT_FILE,
			)
		);
	};
	// the config a script's rewrite depends on, for its cache key: all of it
	// but the client's name and the site pool's message token, which a
	// controller mints anew (a host that keeps its id across a reload would
	// miss every script; with the pool, every script of a slot's sites on
	// every visit). A page script's output names the client only where the
	// body mentions it (the rewriter routes it) and the token never; a
	// worker's preamble carries the whole config
	const cacheConfig = (
		config: Config,
		type: ScriptType,
		mentions: (name: string) => boolean,
	) => {
		if (type === 'worker' || type === 'workerModule')
			return JSON.stringify(config);
		const client = config.names?.client;
		return JSON.stringify({
			...config,
			...(client !== undefined && !mentions(client)
				? { names: { ...config.names, client: undefined } }
				: {}),
			...(config.sites ? { sites: { ...config.sites, token: undefined } } : {}),
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
		/** where `markup` starts in the document: the lines before, the column */
		at: [number, number] = [0, 0],
	): {
		dispatched: Promise<void>;
		finish: () => Promise<Prewritten>;
	} | null => {
		const pool = rewriter.pool;
		if (!pool?.live) return null;
		const config = rewriter.config;
		// one pass of the wasm scanner over the markup finds the inline scripts
		// and styles and whether the document has a <base> (null when the
		// thread holds no module yet: the markup is scanned in JavaScript)
		const scanned = scanMarkup(markup);
		if (scanned ? scanned.base : hasBase(markup)) return null;
		const { scripts, styles } = inlineSources(markup, scanned ?? undefined);
		const handlers = handlerSources(markup);
		if (!scripts.length && !styles.length && !handlers.length) return null;
		const rewrites = partition !== null ? rewriter.rewrites : undefined;
		const encoder = new TextEncoder();
		const dispatches: Promise<void>[] = [];
		const access = helperNames(config).access;
		// where each script's text starts in the document, as V8 counts a
		// script of the document from (its frames' lines are the document's):
		// the lines before (line feeds; a carriage return alone ends none,
		// measured) and its column (rewriteJS.ts ScriptSource.place)
		let [lines, lineStart] = [at[0], -at[1]];
		let counted = 0;
		const places = scripts.map(([, , start]): [number, number] => {
			for (
				let end = markup.indexOf('\n', counted);
				end >= 0 && end < start;
				end = markup.indexOf('\n', end + 1)
			) {
				lines++;
				lineStart = end + 1;
			}
			counted = Math.max(counted, start);
			return [lines, start - lineStart];
		});
		// where each handler's start tag ends, which V8 counts its positions
		// from (the place handlerPlace finds in the page)
		const ends = [
			...new Set(
				handlers.flatMap(([, , , places]) => places.map(([, e]) => e)),
			),
		].sort((a, b) => a - b);
		const tagPlaces = new Map<number, [number, number]>();
		{
			let [lines, lineStart] = [at[0], -at[1]];
			let counted = 0;
			for (const tagEnd of ends) {
				for (
					let end = markup.indexOf('\n', counted);
					end >= 0 && end < tagEnd;
					end = markup.indexOf('\n', end + 1)
				) {
					lines++;
					lineStart = end + 1;
				}
				counted = Math.max(counted, tagEnd);
				tagPlaces.set(tagEnd, [lines, tagEnd - lineStart]);
			}
		}
		const handlerOutputs = handlers.map(
			async ([source, start, end, places]): Promise<
				NonNullable<Prewritten['handlers']>[number] | null
			> => {
				const entry = (
					output: string,
					map: string,
				): NonNullable<Prewritten['handlers']>[number] => [
					start,
					end,
					output,
					map,
					places.map(([name, tagEnd]) => [name, ...tagPlaces.get(tagEnd)!]),
				];
				let sent!: () => void;
				dispatches.push(new Promise((resolve) => (sent = resolve)));
				try {
					const preamble = handlerPreamble(access, sourceKey(source));
					const key = rewrites
						? await rewrites.key(
								[
									CACHE_GENERATION,
									url.toString(),
									'generic',
									'handler',
									cacheConfig(config, 'generic', (name) =>
										source.includes(name),
									),
									url.codec.key,
									partition!,
								],
								encoder.encode(source),
							)
						: null;
					const kept = key !== null ? await rewrites!.match(key) : null;
					if (kept !== null)
						return entry(
							await kept.text(),
							(await (await rewrites!.match(`${key}m`))?.text()) ?? '',
						);
					const told: RewrittenBy = {};
					const rewriting = pool.rewriteHandler(
						source,
						url,
						config,
						preamble,
						told,
					);
					sent();
					const output = await rewriting;
					if (output === null) return null;
					if (key !== null) {
						void rewrites!.put(key, output);
						if (told.map) void rewrites!.put(`${key}m`, told.map);
					}
					return entry(output, told.map ?? '');
				} finally {
					sent();
				}
			},
		);
		for (const output of handlerOutputs) output.catch(() => {});
		const outputs = scripts.map(
			async (
				[kind, source, start, end],
				index,
			): Promise<Prewritten['scripts'][number] | null> => {
				const entry = (
					output: string,
					map: string,
				): Prewritten['scripts'][number] => [
					kind,
					start,
					end,
					...packRewrite(kind, source, output, access),
					map,
					places[index]!,
				];
				let sent!: () => void;
				dispatches.push(new Promise((resolve) => (sent = resolve)));
				try {
					const type: ScriptType = kind === 'm' ? 'genericModule' : 'generic';
					const key = rewrites
						? await rewrites.key(
								[
									CACHE_GENERATION,
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
					// (the map the rewrite handed over apart is kept beside it)
					const kept = key !== null ? await rewrites!.match(key) : null;
					if (kept !== null)
						return entry(
							await kept.text(),
							(await (await rewrites!.match(`${key}m`))?.text()) ?? '',
						);
					const told: RewrittenBy = {};
					// with nothing to keep, the worker packs it for the table
					if (key === null) {
						const packing = pool.packInline(
							source,
							url,
							config,
							type,
							access,
							told,
						);
						sent();
						const packed = await packing;
						return packed === null
							? null
							: [kind, start, end, ...packed, told.map ?? '', places[index]!];
					}
					const rewriting = pool.rewriteInline(
						source,
						url,
						config,
						type,
						kind === 'm' ? '' : scriptPreamble(source),
						told,
					);
					sent();
					const output = await rewriting;
					if (output === null || output === source) return null;
					void rewrites!.put(key, output);
					if (told.map) void rewrites!.put(`${key}m`, told.map);
					return entry(output, told.map ?? '');
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
				// the scanner module, when it is still being compiled
				if (styles.length) await scannerSettled();
				// as the client's prepareStyleText makes them
				const styleOutputs = styles.map(
					([source, start, end]): Prewritten['styles'][number] => {
						let output: string;
						try {
							output = modifyCSS(source, url, 'stylesheet', {});
						} catch (error) {
							output = rewriteCSSValueURLs(source, url);
						}
						return [start, end, packStyle(source, output)];
					},
				);
				const done = await Promise.all(outputs);
				const handled = (await Promise.all(handlerOutputs)).filter(
					(entry): entry is NonNullable<Prewritten['handlers']>[number] =>
						entry !== null,
				);
				return {
					url: url.toString(),
					scripts: done.filter(
						(entry): entry is Prewritten['scripts'][number] => entry !== null,
					),
					styles: styleOutputs,
					...(handled.length ? { handlers: handled } : {}),
				};
			},
		};
	};
	const scriptTypeFactory = (type: ScriptType) =>
		genericForward(
			rewriter,
			async (url, response, headers, _referrer, request, note) => {
				if (!response.ok) return false;
				// a worker's own script (not a module it imports: those are
				// `cors`) hands its client the policies its requests are judged
				// by (src/csp.ts WorkerPolicies): the browser applies none of the
				// worker's own policy to the proxy's URLs. This worker judges the
				// worker's requests by them too (src/server/contentPolicies.ts)
				const own =
					(type === 'worker' || type === 'workerModule') &&
					(request.destination === 'worker' ||
						request.destination === 'sharedworker') &&
					request.mode === 'same-origin';
				if (own && request.resultingClientId)
					rememberWorkerPolicies(
						request.resultingClientId,
						url.url,
						responsePolicies(response.headers),
					);
				const policies = own ? workerPolicies(response.headers, url.url) : null;
				const preamble = policies
					? `${helperNames(rewriter.config).client}.judgeConnections(${JSON.stringify(policies)});`
					: '';
				// decoded as the browser would have (a byte order mark, the
				// Content-Type charset), and the rewrite goes out as UTF-8 and
				// says so, or the origin's charset would decode it again
				const contentType = headers.get('content-type');
				if (contentType !== null)
					headers.set('content-type', utf8ContentType(contentType));
				// a classic script that names no type at all would be decoded
				// with its document's encoding (a legacy one is served as it is,
				// src/server/charset.ts encodeShell); the type it gets is the one
				// the browser assumed (under nosniff the browser refuses it
				// without one, so that one keeps none)
				else if (
					type === 'generic' &&
					!response.headers.has('x-content-type-options')
				)
					headers.set('content-type', 'text/javascript; charset=utf-8');
				const isModuleType =
					type === 'genericModule' ||
					type === 'workerModule' ||
					type === 'workletModule';
				// an element's classic script that names no encoding is in its
				// document's (a worker's script is UTF-8)
				const environment =
					type === 'generic' ? documentEncodingOf(request.clientId) : 'utf-8';
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
					const body = await BodyBytes.read(response);
					const read = body.bytes;
					note.bytes = body.size;
					if (
						scriptEncoding(read, contentType, isModuleType, environment) ===
						'utf-8'
					)
						return rewriteScriptBytes(body, url, type, note, preamble);
					return rewriteScript(
						decodeScript(read, contentType, isModuleType, environment),
						url,
						type,
						note,
						preamble,
					);
				}
				// The key is a digest of the bytes as they came, and a script kept
				// rewritten goes out as the store's own Response: a hit decodes
				// nothing and makes no string of the output (YouTube's bundle is
				// 10 MB in and 20 MB out, read, decoded and encoded again on
				// every load).
				const body = await BodyBytes.read(response);
				const bytes = body.bytes;
				note.bytes = body.size;
				const encoding = scriptEncoding(
					bytes,
					contentType,
					isModuleType,
					environment,
				);
				const key = await rewrites.key(
					[
						CACHE_GENERATION,
						url.toString(),
						type,
						cacheConfig(rewriter.config, type, (name) =>
							includesASCII(bytes, name),
						),
						url.codec.key,
						partition,
						// (the policies are the response's, not the body's)
						...(preamble ? [preamble] : []),
						// the same bytes decoded otherwise are another script (UTF-8,
						// the encoding of every script before, keeps its keys)
						...(encoding === 'utf-8' ? [] : [encoding]),
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
				// as the browser decodes it (a BOM goes, bad bytes are U+FFFD):
				// UTF-8 by the rewriter itself
				const output =
					encoding === 'utf-8'
						? await rewriteScriptBytes(body, url, type, note, preamble)
						: await rewriteScript(
								new TextDecoder(encoding).decode(bytes),
								url,
								type,
								note,
								preamble,
							);
				note.rewriteCache = 'miss';
				return output;
			},
			// a worker redirected stays in the partition it was started in,
			// and as isolated as its creator
			(resource, url, kind) =>
				routeJS(
					resource,
					url,
					rewriter.config,
					type,
					kind ? workerKindPartition(kind, rewriter.codec) : '',
					'',
					!!kind && workerKindUnisolated(kind),
				),
			undefined,
			(headers, filteredHeaders) => {
				for (const header of integrityHeaders) {
					filteredHeaders.delete(header);
				}
				// a script keeps the type it came with, so the browser refuses
				// one whose server says nosniff and names no script type, as
				// it does natively (a worker's script fires `error`, an
				// element's too, importScripts throws)
				const sniffing = headers.get('x-content-type-options');
				if (sniffing !== null)
					filteredHeaders.set('x-content-type-options', sniffing);
			},
		);

	// a request a worker's policy refused (src/routeURL.ts routeRefused): a
	// network error, as the browser fails a refused request; an EventSource
	// fails its connection on a response that is not a stream, and is closed
	// as natively (on a network error it would reconnect)
	router.routes.set(new RegExp(`^/${REFUSED_ROUTE}/`), () => Response.error());
	router.routes.set(
		new RegExp(`^/${REFUSED_SOURCE_ROUTE}/`),
		() => new Response(null, { status: 204 }),
	);
	// the controller's probe of the browser's isolation rules
	// (src/controller/isolationProbe.ts): a worker (`c`, with COEP
	// credentialless) or a frame (`p`, `d`) of the controller's own document,
	// answered here with the embedder policy (and the
	// Document-Isolation-Policy) its kind names. Only to a worker or a
	// navigation: no page learns of the browser's answer by loading it
	// the agent of the documents the proxy isolates with a
	// Document-Isolation-Policy (./apartAgent.ts): once, for the controller
	router.routes.set(APART_AGENT_PATH, async (request, path) => {
		const token = APART_AGENT_PATH.exec(path)?.[1];
		return (
			(request.mode === 'navigate' &&
				request.destination === 'iframe' &&
				token &&
				apartAgentResponse(token)) ||
			Response.error()
		);
	});
	router.routes.set(
		new RegExp(`^/${ISOLATION_PROBE}/[cpdb]$`),
		async (request, path) => {
			const kind = path.slice(-1);
			// the browser's about:blank rule (src/isolation.ts IsolationEngine
			// `blank`), which the inject asks for: no more than the browser
			// tells any page of itself
			if (kind === 'b')
				return new Response(
					JSON.stringify((await rewriter.isolationEngine()).blank),
					{
						headers: {
							'content-type': 'application/json',
							'cache-control': 'no-store',
						},
					},
				);
			if (kind === 'c')
				return request.destination === 'worker'
					? new Response('postMessage(crossOriginIsolated)', {
							headers: {
								'content-type': 'text/javascript',
								'cache-control': 'no-store',
								'cross-origin-embedder-policy': 'credentialless',
							},
						})
					: Response.error();
			if (request.mode !== 'navigate') return Response.error();
			const headers = new Headers({
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store',
				'cross-origin-embedder-policy': 'require-corp',
			});
			if (kind === 'd')
				headers.set('document-isolation-policy', 'isolate-and-require-corp');
			return new Response(
				`<!doctype html><title>${ISOLATION_PROBE}</title><script>parent.postMessage(${JSON.stringify(ISOLATION_PROBE)} + crossOriginIsolated, '*')</script>`,
				{ headers },
			);
		},
	);

	router.routes.set(/^\/js:generic\//, scriptTypeFactory('generic'));
	router.routes.set(
		/^\/js:genericModule\//,
		scriptTypeFactory('genericModule'),
	);
	router.routes.set(
		/^\/js:workletModule\//,
		scriptTypeFactory('workletModule'),
	);
	router.routes.set(
		/^\/js:worker(:n)?(:top:[^/]*)?\//,
		scriptTypeFactory('worker'),
	);
	router.routes.set(
		/^\/js:workerModule(:n)?(:top:[^/]*)?\//,
		scriptTypeFactory('workerModule'),
	);

	// an import map's trailing-slash prefix target (src/scriptRoutes.ts
	// routeModulePrefix): the path is a codec-sealed prefix URL in one segment
	// and the suffix the browser appended to it, so the real module URL is the
	// suffix resolved against the opened prefix. It redirects to the module's
	// own route, so the browser loads it, names it and resolves its relative
	// imports exactly as a directly imported module.
	router.routes.set(
		new RegExp(`^/${MODULE_PREFIX_ROUTE}/`),
		async (serverRequest) => {
			const oURL = new URL(serverRequest.url);
			const rest = oURL.pathname.slice(
				`${rewriter.directory}${MODULE_PREFIX_ROUTE}/`.length,
			);
			const slash = rest.indexOf('/');
			const sealed = slash === -1 ? rest : rest.slice(0, slash);
			const suffix = slash === -1 ? '' : rest.slice(slash + 1);
			let module: StompURL;
			try {
				const prefix = rewriter.codec.decode(sealed);
				if (!prefix) throw new Error('empty prefix');
				module = new StompURL(
					new URL(suffix + oURL.search + fragmentOf(oURL), prefix),
					rewriter.codec,
					rewriter.directory,
				);
			} catch (error) {
				// a specifier the browser escaped above the prefix, or no prefix:
				// the browser reports it as a failed module load, as it would a
				// bad bare specifier
				return new Response('bad module specifier', { status: 400 });
			}
			return new Response(undefined, {
				headers: {
					location: routeJS(module, module, rewriter.config, 'genericModule'),
				},
				status: 307,
			});
		},
	);

	router.routes.set(
		/^\/css\//,
		genericForward(
			rewriter,
			async (url, response, headers, _referrer, request, note) => {
				if (!response.ok) return false;
				// decoded as the browser would have (a byte order mark, the
				// Content-Type charset, an @charset rule, else its document's
				// encoding), and the rewrite goes out as UTF-8 and says so: the
				// browser would decode a sheet that names none with the
				// document's encoding (src/server/charset.ts encodeShell)
				const read = new Uint8Array(await response.arrayBuffer());
				note.bytes = read.byteLength;
				const contentType = headers.get('content-type');
				if (contentType !== null)
					headers.set('content-type', utf8ContentType(contentType));
				const text = new TextDecoder(
					stylesheetEncoding(
						read,
						contentType,
						documentEncodingOf(request.clientId),
					),
				).decode(read);
				try {
					// the wasm scanner rewrites the sheet (waited for when this
					// worker has only just been handed the module), and the request
					// log says whether it did (a sheet with nothing to route is not
					// looked into)
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

	// a script or a stylesheet in a Blob the page made and the inject never
	// read (src/inject/modules/ObjectURL.ts): the route names the page's
	// blob: URL (what its loads read back) and, when the page's realm holds
	// the Blob, the private URL it minted of it (which the page's revoke does
	// not reach). Read from this origin's blob: URL registry and rewritten
	// here; a URL another origin's page minted (the worker recorded it) or
	// one that no longer resolves is a network error, as natively.
	// a blob: script or stylesheet a script the worker rewrites names (a
	// static import of a module the page made): routed the same way, by the
	// page's URL, as the worker holds no Blob of the page's
	setBlobRoute((kind, href, given) => {
		const script = /^js:(generic|genericModule|workerModule)$/.exec(kind)?.[1];
		if (!script && kind !== 'css') return null;
		if (!/^blob:[^/]+\/\/[^/]+\/[\da-f-]{36}$/.test(given)) return null;
		return `${rewriter.directory}blob~${script === 'generic' ? 'js' : script ? 'module' : 'css'}/${rewriter.codec.encode(given)}`;
	}, true);

	// a realm's bytes of a Blob behind a private URL (handedBlobs): kept as
	// its own real origin's, from its client's URL, as BLOB_MINTED records a
	// minted URL's. 204 tells it this worker reads its blob: URLs itself
	router.routes.set(BLOB_BYTES_ROUTE, async (request, path, context) => {
		if (request.method !== 'POST') return Response.error();
		const uuid = BLOB_BYTES_ROUTE.exec(path)![1];
		// an asked realm's answer (askedBlob): the bytes, or that it holds
		// no such Blob, which ends the wait for them
		const answer = request.headers.get(BLOB_ANSWER_HEADER);
		if (answer === 'none') {
			for (const wake of handedWaits.get(uuid) ?? []) wake();
			handedWaits.delete(uuid);
			return new Response(null, { status: 202 });
		}
		await learnBlobsReadable();
		// (else learned of a blob: URL's bytes a realm offers; an inline
		// document's are kept until it is served, which reads them or the Blob)
		if (blobsReadable === undefined && !answer && uuid.length === 36)
			try {
				await (await fetch(`blob:${location.origin}/${uuid}`)).body?.cancel();
				blobsReadable = true;
			} catch (error) {
				blobsReadable = false;
			}
		if (blobsReadable) return new Response(null, { status: 204 });
		const found =
			context?.clientId && typeof clients !== 'undefined'
				? await clients.get(context.clientId).catch(() => undefined)
				: undefined;
		let origin: string | undefined;
		try {
			origin = found?.url.startsWith('blob:')
				? (await knownOriginOf(found.url))?.origin
				: parseRoutedURL(
						found?.url ?? '',
						rewriter.codec,
						`${location.origin}${rewriter.directory}`,
					).url.url.origin;
		} catch (error) {
			// not a routed document's nor a known blob: worker's
		}
		if (!origin) return Response.error();
		handBlob(uuid, {
			origin,
			type: request.headers.get('content-type') ?? '',
			bytes: await request.arrayBuffer(),
		});
		return new Response(null, { status: 202 });
	});

	router.routes.set(BLOB_ROUTE, async (request, path, context) => {
		const [, kind, at] = BLOB_ROUTE.exec(path)!;
		let page: StompURL;
		try {
			page = parseRoutedURL(
				request.url,
				rewriter.codec,
				`${location.origin}${rewriter.directory}`,
			).url;
		} catch (error) {
			return Response.error();
		}
		const inner = page.url.pathname;
		const uuid = at ?? inner.slice(inner.lastIndexOf('/') + 1);
		if (page.url.protocol !== 'blob:' || !/^[\da-f-]{36}$/.test(uuid))
			return Response.error();
		// (a page of the proxy's own origin names it in its form, whose UUID
		// differs: routeURL.ts setBlobOrigins)
		const blobURL = `blob:${location.origin}/${
			at ??
			proxyBlobUUID(uuid, page.url.origin, location.origin, rewriter.codec.key)
		}`;
		const minter = await knownOriginOf(blobURL);
		if (minter && minter.origin !== page.url.origin) return Response.error();
		// a private URL's bytes its realm handed over, when this worker
		// cannot read it (handedBlobs): only that realm's origin's
		let type: string | null;
		let bytes: Uint8Array;
		const ready = at ? handedBlobs.get(at) : undefined;
		if (ready && ready.origin === page.url.origin) {
			type = ready.type;
			bytes = new Uint8Array(ready.bytes);
		} else
			try {
				const response = await fetch(blobURL);
				type = response.headers.get('content-type');
				bytes = new Uint8Array(await response.arrayBuffer());
				blobsReadable = true;
			} catch (error) {
				// a URL alone (a static import the worker routed) is asked of
				// the realms that may hold its Blob
				const kept = at
					? await handedBlob(at)
					: await askedBlob(
							blobURL,
							await knownMinterOf(blobURL),
							context?.clientId,
						);
				if (kept?.origin !== page.url.origin) return Response.error();
				type = kept.type;
				bytes = new Uint8Array(kept.bytes);
			}
		const headers: Record<string, string> = { 'cache-control': 'no-store' };
		if (kind === 'css') {
			if (type) headers['content-type'] = type;
			const text = new TextDecoder().decode(bytes);
			let output: string;
			try {
				await scannerSettled();
				output = modifyCSS(text, page, 'stylesheet', {});
			} catch (error) {
				output = rewriteCSSValueURLs(text, page);
			}
			return new Response(output, { headers });
		}
		// a blob of no type runs natively, as a classic script and as a
		// module (blob-scripts-plain suite); a worker's classic script of any
		// type too (Worker_script_mimetype); one of another type is the
		// browser's to judge
		headers['content-type'] = utf8ContentType(
			(kind !== 'wjs' && type) || 'text/javascript',
		);
		const module = kind === 'module';
		// (its output carries the map of itself to the page's text, as a
		// script file's does: a frame of a blob: script, a worker's among
		// them, reads its place in the page's Blob)
		return new Response(
			modifyJS(
				decodeScript(bytes, type, module),
				page,
				rewriter.config,
				module ? 'genericModule' : 'generic',
				'',
				SCRIPT_FILE,
			),
			{ headers },
		);
	});

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
			// of its creator's site, whose cache mark it takes (an opaque
			// origin's document keeps none, src/memoryMark.ts)
			url.mark = /^https?:$/.test(url.url.protocol)
				? cacheMarkOf(siteOf(url.url, publicSuffix))
				: '';
			// a document of a local scheme (about:, blob:, data:) inherits its
			// creator's referrer policy, which this navigation's request carries
			if (request.referrerPolicy)
				headers['referrer-policy'] = request.referrerPolicy;
			// and a blob: document its creator's embedder policy: isolated as
			// its creator is (an inline document of markup never is). Under a
			// host that is not isolated, a document a creator in the cluster of
			// the proxy's Document-Isolation-Policy registered is served with it
			// too, as natively such a document inherits its creator's
			// (src/server/apartAgent.ts)
			const apartEntry = !rewriter.isolated && !!entry.apart;
			if (apartEntry)
				headers['document-isolation-policy'] = 'isolate-and-credentialless';
			else if (entry.blob && entry.isolated) {
				const isolation = new Headers();
				isolationResponseHeaders(isolation, {
					isolated: true,
					topLevel: request.destination === 'document',
				});
				isolation.forEach((value, name) => (headers[name] = value));
			}
			let markup = entry.markup;
			if (entry.blob) {
				// a Blob the page never had read (src/server/inline.ts): an HTML
				// one is rewritten as the markup would be, an XML one gets the XML
				// shell, and anything else goes as it is, under its own type and
				// unsniffed (it runs nothing natively). A revoked URL is the
				// network error the browser's navigation to it would be. Where
				// this worker cannot read the page's blob: URL or the Blob it
				// posted (Firefox and WebKit in a frame of another site's page;
				// WebKit cannot read a posted Blob: handedBlobs), the bytes
				// its creator handed over, or that the realms holding it give
				// when asked
				let blob: { type: string; bytes: ArrayBuffer } | undefined;
				try {
					const read =
						typeof entry.blob === 'string'
							? await (await fetch(entry.blob)).blob()
							: entry.blob;
					blob = { type: read.type, bytes: await read.arrayBuffer() };
				} catch (error) {
					const kept =
						typeof entry.blob === 'string'
							? await askedBlob(
									entry.blob,
									await knownMinterOf(entry.blob),
									entry.client,
								)
							: await handedBlob(token);
					if (kept?.origin === url.url.origin) blob = kept;
				}
				const handed = handedBlobs.get(token);
				if (handed) {
					handedBlobs.delete(token);
					handedSize -= handed.bytes.byteLength;
				}
				if (!blob) return Response.error();
				const mime = getMime(blob.type).trim().toLowerCase();
				const bytes = new Uint8Array(blob.bytes);
				if (isXMLDocumentMime(mime)) {
					headers['content-type'] = `${mime}; charset=utf-8`;
					return new Response(
						modifyXML(
							decodeDocument(bytes, blob.type),
							url,
							apartEntry
								? { ...rewriter.config, isolated: true }
								: rewriter.config,
							mime,
							undefined,
							shellSites(url),
							false,
							undefined,
							undefined,
							undefined,
							true,
						),
						{ headers },
					);
				}
				if (mime !== 'text/html')
					return new Response(bytes, {
						headers: {
							...headers,
							'content-type': blob.type || 'text/plain',
							'x-content-type-options': 'nosniff',
						},
					});
				markup = decodeDocument(bytes, blob.type);
			}
			return new Response(
				modifyHTML(
					markup,
					url,
					apartEntry ? { ...rewriter.config, isolated: true } : rewriter.config,
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

	// the rest of a document's markup, for the client its shell made
	router.routes.set(
		new RegExp(`^/${MARKUP_ROUTE}-([A-Za-z0-9_-]{22})$`),
		(_request, path) => {
			const token = path.slice(MARKUP_ROUTE.length + 2);
			const kept = markupStreams.get(token);
			if (!kept) return new Response(null, { status: 404 });
			markupStreams.delete(token);
			clearTimeout(kept.timer);
			return new Response(kept.stream, {
				headers: {
					'content-type': 'text/plain; charset=utf-8',
					'cache-control': 'no-store',
					// (a document of an opaque origin reads it too: one the page
					// sandboxed without allow-same-origin)
					'access-control-allow-origin': '*',
				},
			});
		},
	);

	router.routes.set(
		DOCUMENT_ROUTE,
		genericForward(
			rewriter,
			async (url, response, responseHeaders, referrer, request, note) => {
				// a frame whose own frame-ancestors or X-Frame-Options refuses one
				// of its real ancestors is refused by the browser, which shows its
				// error page as natively (no event anywhere), whatever its type;
				// so is one that does not take on the policy its frame's csp
				// attribute requires (CSP Embedded Enforcement). One that lets its
				// parent's origin set that policy (Allow-CSP-From) is held to it
				// as to a policy of its own
				const embedded = request.requiredCSP
					? embeddingVerdict(
							response.headers,
							request.requiredCSP,
							request.ancestors?.[0],
						)
					: 'accept';
				if (
					(request.ancestors &&
						refusesAncestors(response.headers, url.url, request.ancestors)) ||
					embedded === 'refuse'
				)
					responseHeaders.append(
						'content-security-policy',
						"frame-ancestors 'none'",
					);
				let pageHeaders = response.headers;
				if (embedded === 'apply') {
					pageHeaders = new Headers(pageHeaders);
					pageHeaders.append('content-security-policy', request.requiredCSP!);
				}
				let contentType = responseHeaders.get('content-type');
				let mime = getMime(contentType || '');
				// a proxied top (not a document a page routed as nested): its
				// shell loads the rewriter library
				const top =
					request.navigation &&
					nestedTopOf(
						new URL(request.routed).pathname,
						rewriter.directory,
						rewriter.codec,
					) === null;
				// the extensions whose content scripts the document runs, or
				// the extension page it is (docs/extensions.md): nothing for a
				// document no extension reaches
				// (a slot of the site pool asks the hub's worker, whose the
				// extensions are; the Web Store's pages are its own)
				const remote =
					rewriter.remoteExtensions && !isStoreURL(url.url.href)
						? rewriter.remoteExtensions
						: undefined;
				const extensionShellOf = (documentType?: string) => {
					const doc: ShellDocument = {
						url: url.url.href,
						client: request.clientId ?? '',
						navigationClient:
							request.mode === 'navigate'
								? request.resultingClientId
								: undefined,
						top,
						directory: rewriter.directory,
						...(documentType ? { contentType: documentType } : {}),
					};
					const runtime = extensionsRuntimeJS(url, rewriter.config);
					const access = helperNames(rewriter.config).access;
					if (remote) return remote.shell(doc, runtime, access);
					return documentShell(rewriter.extensions!, doc, {
						runtime,
						access,
						rewriteCSS: (css, file) =>
							modifyCSS(
								css,
								new StompURL(file, rewriter.codec, rewriter.directory),
							),
					});
				};
				// a text document Chrome renders (JSON, plain text, a script)
				// that an extension reaches is served as the HTML Chrome makes
				// of it, so the extension's content scripts run there as
				// natively (./extensions/textDocument.ts). Its document reads
				// the type it came as. One no extension reaches, one that
				// downloads, a fetch and an extension's own file pass through
				// untouched
				const textKind =
					(remote?.any || rewriter.extensions?.any) &&
					(request.mode === 'navigate' || request.navigation) &&
					/^https?:$/.test(url.url.protocol) &&
					!/^\s*attachment/i.test(
						response.headers.get('content-disposition') ?? '',
					)
						? textDocumentKind(mime)
						: null;
				const textShell = textKind ? await extensionShellOf(mime) : null;
				if (textKind && textShell) {
					const headers = new Headers(response.headers);
					headers.set('content-type', 'text/html; charset=utf-8');
					response = new Response(
						textDocumentBody(response.body, contentType, textKind),
						{
							status: response.status,
							statusText: response.statusText,
							headers,
						},
					);
					contentType = 'text/html; charset=utf-8';
					mime = 'text/html';
				}
				// a type that says nothing is sniffed by the browser as it
				// would sniff the origin's answer (src/server/sniff.ts): a
				// body the worker passes through as not a document that the
				// browser then reads as HTML would run its scripts unrewritten
				let sniffed = false;
				if (
					(!htmlMimes.includes(mime) && !isXMLDocumentMime(mime)) ||
					mime === ''
				) {
					if (!unknownMime(mime)) return false;
					// nosniff: no sniff, and the browser is told so (it would
					// sniff what the worker passes on)
					if (saysNosniff(response.headers)) {
						const type = nosniffType(mime, contentType);
						if (type !== null) responseHeaders.set('content-type', type);
						responseHeaders.set('x-content-type-options', 'nosniff');
						return false;
					}
					const head = await firstBytes(response);
					const as = sniffDocument(head);
					// (an answer with no type that sniffs as XML is shelled as
					// HTML, as it always was: XML documents are another
					// stream's)
					if (as === null || (as === 'xml' && mime !== '')) return false;
					sniffed = as === 'html';
				}
				// decode the way the browser would have (BOM, header charset,
				// <meta charset>), then serve the shell in that encoding
				// (encodeShell): the document has it, as natively, for what the
				// browser encodes with it (an element's URL, a form's query) and
				// for document.characterSet. An XML document is decoded by the
				// XML rules (no meta, the declaration's encoding) and its shell
				// served in what they name, as an HTML one is.
				//
				// An HTML document is read as it comes: its encoding is known from
				// its first 1024 bytes, and what its head's metas say (its
				// policies, its client hints) once the body starts. The shell goes
				// out then, and the rest of the markup follows it as it arrives
				// (streamMarkup), where the page waited for the last byte.
				//
				// A head that pauses HEAD_GAP_MS, or is still coming HEAD_CAP_MS,
				// after the first 1024 bytes (YouTube's 800 KB) does not hold the
				// commit: the shell goes out then, made of the head so far, as
				// the browser commits a document on its first bytes, and the
				// bundles load while the head comes. The rest of the head follows
				// in the markup stream as it arrives, with what its metas say
				// (streamMarkup's `told`), and the page writes it as it comes.
				const xml = isXMLDocumentMime(mime);
				const read = xml
					? null
					: await readHead(response, contentType, HEAD_GAP_MS, HEAD_CAP_MS);
				const early = read !== null && read.head !== true;
				let bytes: Uint8Array | null = null;
				if (!read) {
					bytes = new Uint8Array(await response.arrayBuffer());
					note.bytes = bytes.byteLength;
				} else if (!read.rest) note.bytes = read.bytes;
				let encoding = read
					? read.encoding
					: xml
						? xmlEncoding(bytes!, contentType)
						: documentEncoding(bytes!, contentType);
				const decoded = read
					? read.text
					: decodeDocument(bytes!, contentType, encoding);
				// (a root whose name the shell cannot write in a legacy
				// encoding: the shell is UTF-8, xmlShell.ts)
				if (xml) encoding = xmlShellEncoding(decoded, encoding);
				responseHeaders.set(
					'content-type',
					documentContentType(sniffed ? 'text/html' : contentType, encoding),
				);
				// what it loads that names no encoding is in its own
				if (request.navigation)
					rememberDocumentEncoding(request.clientId, encoding);
				// the page's own policies, as far as the browser can apply them
				// to the proxy's URLs (src/csp.ts); the inject is told which
				// page policy each one stands for
				// (the shell's and the inject's own scripts carry the document's
				// nonce, which the browser's script policies name; a worker of
				// the document imports the inject by its URL)
				const nonce = policyNonce();
				const policies = browserHeaders(
					pageHeaders,
					policyMark(),
					url.url,
					// (a slot of the site pool: a frame or a form of a site
					// another slot shows goes there by a 307 the browser judges)
					rewriter.config.sites?.origins,
				);
				// "Block scripts" shield: the inject enforces script-src 'none'
				// against the page's own code (src/csp.ts stage 2; the inject's own
				// scripts are exempt by design). It rides as a page policy with no
				// browser text, so the browser never gets it (a script-src header
				// would kill STomp's shell) and only the inject's page-code
				// enforcement sees it. Off unless the host's shields turn it on.
				if (rewriter.shields?.blockScripts(url.url.hostname))
					policies.texts.push(['', "script-src 'none'", 'enforce']);
				// whether code made from a string runs, under the headers' policies
				// and the metas' of the head (src/csp.ts ScriptFacts)
				const factsOf = (metas: Policy[]) => {
					const texts = [
						...policies.texts.map(([browser]) => browser).filter(Boolean),
						...metas
							.map((policy) => browserContentPolicy(policy))
							.filter((text) => text !== null),
					];
					// the page's own policies (headers' and the head's metas'), which
					// the inject enforces against the page's code (the browser never
					// gets their script/style/Trusted-Types directives, src/csp.ts)
					const ownPolicies = [
						...policies.texts.flatMap(([, page, disposition]) =>
							parsePolicies(page, disposition, 'header'),
						),
						...metas,
					];
					return scriptFacts(texts, nonce, ownPolicies);
				};
				// (a head still coming: its metas so far, and the client is told
				// what later ones say as their piece of the markup reaches it)
				const metas = metaPolicies(decoded);
				const facts = factsOf(metas);
				// its report-to endpoints, which the inject hands its reports
				// to this worker for (reportUploads.ts)
				const reportTo = reportingEndpoints(
					response.headers.get('reporting-endpoints'),
					url.url,
				);
				if (reportTo) facts.reportTo = reportTo;
				// a top-level document's opener policy, which the browser never
				// gets as the page sent it: a popup's window leaves its browsing
				// context group when Chrome's rule says it does, by a policy of
				// the worker's own (src/coop.ts). Under an isolated host every
				// popup keeps the host's (src/isolation.ts)
				if (request.opener) {
					const own = openerPolicy(
						response.headers.get('cross-origin-opener-policy'),
						url.url.origin,
					);
					let real = '';
					if (request.opener.window && !rewriter.isolated) {
						const told = request.opener.facts;
						real = told
							? realPolicy(told[3], switchesGroup(told, own, url.url.origin))
							: '';
						if (real) responseHeaders.set('cross-origin-opener-policy', real);
					}
					facts.coop = [own, real];
				}
				// a document its own Document-Isolation-Policy isolates is in an
				// agent cluster apart from its origin's documents that none
				// isolates: they do not reach each other (Context.ts
				// reachableClients). Chrome ignores the policy where the origin
				// is not potentially trustworthy
				const dip = response.headers.get('document-isolation-policy');
				if (
					documentIsolates(dip) &&
					trustworthy(url.url.origin) &&
					(await byEngine(rewriter.isolationEngine, (engine) =>
						documentIsolates(dip, engine),
					))
				)
					facts.dip = true;
				// a slot of the site pool: a frame's parent may be of another
				// slot, out of the frame's reach. Its frame-src judges every
				// navigation of the frame, and the frame's ancestors are what its
				// next document's frame-ancestors judges (NavigationHint)
				if (rewriter.config.sites && request.ancestors)
					facts.framed = {
						policies: request.framePolicies ?? [],
						ancestors: request.ancestors,
					};
				// the document the hints machinery recorded for this response
				// (its permissions policy, under its parent's): whether its real
				// `sync-xhr` is off, which the served Permissions-Policy no longer
				// carries (browserPolicy keeps the feature on so STomp's own inject
				// can make a synchronous XHR), for the inject to emulate for the
				// guest (src/server/clientHints.ts, src/inject/dom/modules/XMLHttpRequest.ts)
				const hints = hintsDocument(request.clientId, request.routed);
				const syncBlocked = hints ? syncXHRBlocked(hints) : false;
				if (policies.enforce)
					responseHeaders.append('content-security-policy', policies.enforce);
				if (policies.report)
					responseHeaders.append(
						'content-security-policy-report-only',
						policies.report,
					);
				// an XML document (a standalone SVG, an XHTML page) keeps its mime
				// and gets an XML shell: the HTML one is not well-formed XML
				if (xml) {
					const shell = modifyXML(
						decoded,
						url,
						rewriter.config,
						mime,
						referrer,
						shellSites(url, request.routed, rewriter.directory),
						top,
						policies.texts,
						facts,
						syncBlocked,
						false,
						encoding,
					);
					return encoding === 'utf-8' ? shell : encodeShell(shell, encoding);
				}
				// A Refresh header schedules its navigation on the document the
				// browser creates for this response, which the shell re-opens to
				// write the page: the re-open drops it. The same value as a meta
				// refresh in the markup lands in the written document instead, and
				// the inject routes it like any meta refresh the page wrote.
				let markup = decoded;
				// a top-level page's Accept-CH and delegate-ch metas count from
				// its first subresource (the preload scanner's)
				if (request.navigation && hints) applyMeta(hints, markup);
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
						pageHeaders.get('content-security-policy'),
					) ||
					metaUpgradesInsecureRequests(markup);
				if (upgradeInsecure && request.navigation)
					rememberUpgradeInsecure(request.routed, request.clientId);
				// what of its policies names hosts is the worker's to apply to
				// its requests (src/server/contentPolicies.ts), its metas' with
				// its headers'
				const judged = (metas: Policy[]) => {
					if (request.navigation)
						rememberPolicies(
							request.routed,
							request.clientId,
							url.url,
							[
								...parsePolicies(
									pageHeaders.get('content-security-policy'),
									'enforce',
									'header',
								),
								...parsePolicies(
									pageHeaders.get('content-security-policy-report-only'),
									'report',
									'header',
								),
								...metas,
							],
							integrityPolicyDestinations(pageHeaders.get('integrity-policy')),
						);
				};
				judged(metaPolicies(markup));
				// A head still coming when the shell went out (readHead's
				// deadline): a meta in a later piece of it is applied as the
				// piece is handed to the client, before the client writes it,
				// as the browser applies a meta when it parses it. Its policies
				// are this worker's from then on, and the client is told what
				// they make of the page's script facts and whether its requests
				// are upgraded (DocumentClient.loadHTMLStream)
				let headMetas = metas;
				let upgraded = upgradeInsecure;
				const told = early
					? (segment: string): HeadTold | null => {
							const more = metaPolicies(segment);
							const upgrade =
								!upgraded && metaUpgradesInsecureRequests(segment);
							if (!more.length && !upgrade) return null;
							headMetas = [...headMetas, ...more];
							judged(headMetas);
							if (upgrade) {
								upgraded = true;
								if (request.navigation)
									rememberUpgradeInsecure(request.routed, request.clientId);
							}
							const now = factsOf(headMetas);
							return {
								facts: { code: now.code, ttActive: now.ttActive, rtt: now.rtt },
								...(upgrade ? { upgrade: true } : {}),
							};
						}
					: null;
				// the blocker's side of the document (docs/adblock.md): the
				// lists' `$csp=` policies the proxy can enforce, beside its own,
				// and the cosmetic rules and scriptlets its inject applies. Shields
				// down (or the blocker off) for this document's host hides nothing
				// and runs no scriptlet, as a content blocker the user turned off
				// for the site would not; STomp's own rewriting is untouched
				const adblockOn =
					!!rewriter.blocker?.ready &&
					(!rewriter.shields || rewriter.shields.blocks(url.url.hostname));
				const adblock = adblockOn
					? await rewriter.blocker!.cosmetic(url.url.href, (script) =>
							modifyJS(script, url, rewriter.config, 'generic'),
						)
					: null;
				const listCsp = adblockOn
					? await rewriter.blocker!.documentCsp(
							url.url.href,
							nestedTopOf(
								new URL(request.routed).pathname,
								rewriter.directory,
								rewriter.codec,
							),
							`${new URL(request.routed).origin}${rewriter.directory}${SEALER_ROUTE}`,
						)
					: null;
				if (listCsp) responseHeaders.append('content-security-policy', listCsp);
				// the fingerprint surfaces STomp protects for this host (its
				// shields): the shell tells the inject which to hook
				// (Config.fingerprintOn), omitted when it is the default set so a
				// default page's config is unchanged. The per-session farbling
				// seed rides along only when a seeded surface (canvas/webgl/audio)
				// is active.
				const fingerprintOn = rewriter.shields?.fingerprintConfig(
					url.url.hostname,
				);
				const fingerprintSeed =
					rewriter.shields &&
					(fingerprintOn ?? FP_DEFAULT_ON_SURFACES).some((surface) =>
						FP_SEEDED_SURFACES.includes(surface),
					)
						? rewriter.shields.seed
						: undefined;
				// where a page that waits synchronously stops this worker
				// (WebKit), what the document reads synchronously comes with it
				// (./syncFrozen.ts): asked of the controller once
				await learnSyncFrozen();
				const seedMark = nestedMarkOf(
					new URL(request.routed).pathname,
					rewriter.directory,
					rewriter.codec,
				);
				const seedNested = seedMark === null ? null : parseNestedMark(seedMark);
				const seed = await syncSeed(
					url.url,
					seedNested?.top ?? url.url.origin,
					seedNested?.crossAncestor ?? false,
					cookies,
					rewriter.storage,
				).catch(() => undefined);
				// under a list's policy the document's realm compiles no codec
				// module: the policy may refuse it, and would tell the page
				// (a document the proxy isolates under a host that is not is
				// told it as under one that is: its inject says whom its frames
				// are embedded by, and answers as what it is natively)
				const shellConfig: Config =
					listCsp ||
					fingerprintOn ||
					fingerprintSeed !== undefined ||
					note.apart ||
					note.hardLoad ||
					seed
						? {
								...rewriter.config,
								...(listCsp ? { codecModule: false } : {}),
								...(fingerprintOn ? { fingerprintOn } : {}),
								...(fingerprintSeed !== undefined ? { fingerprintSeed } : {}),
								...(note.apart ? { isolated: true } : {}),
								...(seed ? { syncSeed: seed } : {}),
								...(note.hardLoad ? { hardLoad: true } : {}),
							}
						: rewriter.config;
				const extensionShell: ExtensionShell | null =
					textShell ??
					(remote?.any ||
					rewriter.extensions?.any ||
					(rewriter.extensions && isStoreURL(url.url.href))
						? await extensionShellOf()
						: null);
				const partition =
					mayKeep({
						method: request.method,
						requestHeaders: request.headers,
						status: response.status,
						responseHeaders: response.headers,
					}) &&
					// (a policy its frame set on it is not the document's)
					embedded !== 'apply'
						? request.partition
						: null;
				// the client the navigation makes, which its shell hands over
				// (DocumentClient.servedClient)
				const served = request.navigation ? request.clientId : undefined;
				// the rest of the markup is still to come: the shell goes out now,
				// and the markup to the client as it comes (streamMarkup)
				if (read?.rest) {
					const token = streamMarkup(
						read,
						markup,
						(segment, at) => prewrite(segment, url, partition, at),
						request.navigation && hints
							? (segment) => applyMeta(hints, segment)
							: null,
						(read) => documentSizes(response.headers, read, note.encodedBytes),
						request.clientId,
						told,
					);
					const shell = modifyHTMLStreamed(
						'',
						url,
						shellConfig,
						referrer,
						note.serviceWorker,
						upgradeInsecure,
						adblock,
						shellSites(url, request.routed, rewriter.directory),
						top,
						note.isolation,
						note.agentCluster,
						policies.texts,
						facts,
						syncBlocked,
						// (absolute: a document of an opaque origin reads it too)
						new URL(
							`${rewriter.directory}${MARKUP_ROUTE}-${token}`,
							request.routed,
						).href,
						served,
						extensionShell?.head,
					);
					return encodeShell(shell.head + shell.tail(null), encoding);
				}
				const job = prewrite(markup, url, partition);
				if (!job) {
					const shell = modifyHTML(
						markup,
						url,
						shellConfig,
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
						policies.texts,
						facts,
						syncBlocked,
						true,
						served,
						extensionShell?.head,
					);
					return encoding === 'utf-8' ? shell : encodeShell(shell, encoding);
				}
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
					shellConfig,
					referrer,
					note.serviceWorker,
					upgradeInsecure,
					adblock,
					shellSites(url, request.routed, rewriter.directory),
					top,
					note.isolation,
					note.agentCluster,
					policies.texts,
					facts,
					syncBlocked,
					undefined,
					served,
					extensionShell?.head,
				);
				const first = encodeShell(head, encoding);
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
								controller.enqueue(encodeShell(tail(table), encoding));
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
					(kind && nestedMarkOfKind(kind, rewriter.codec)) ?? false,
				),
			undefined,
			(headers, filteredHeaders, url) => {
				// the page's X-Frame-Options would refuse the proxy's own frame:
				// the worker judges it against the frame's real ancestors
				// (refusesAncestors)
				filteredHeaders.delete('x-frame-options');

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
				// (a slot of the site pool: its documents are framed by the hub's
				// page and by documents of the other slots)
				if (rewriter.config.frameAncestors?.length) {
					const sites = rewriter.config.sites;
					const ancestors = new Set([
						...rewriter.config.frameAncestors,
						...(sites ? [sites.hub, ...(sites.origins ?? [])] : []),
					]);
					filteredHeaders.set(
						'content-security-policy',
						`frame-ancestors 'self' ${[...ancestors].join(' ')}`,
					);
				}

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

	/**
	 * Where a GET form's submission goes on to (`url`, the URL the browser
	 * built; `oURL`, the route it was submitted to): its document's sealed
	 * address, through the link route of the document that holds the form
	 */
	const formLocation = (
		serverRequest: Request,
		oURL: URL,
		url: StompURL,
	): string => {
		const target = routeHTML(
			url,
			url,
			rewriter.config,
			false,
			nestedMarkOf(oURL.pathname, rewriter.directory, rewriter.codec) ?? false,
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
							nestedTopOf(from.pathname, rewriter.directory, rewriter.codec) ??
								source.origin,
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
						nested:
							nestedMarkOf(oURL.pathname, rewriter.directory, rewriter.codec) ??
							false,
						hops: 1,
					});
				}
			} catch (error) {
				// no referrer, or not a document of this controller: as before
			}
		return location;
	};

	// a frame's document says its navigation goes on in a fresh browsing
	// context (messages.ts FRESH_RETURN_ROUTE): from a routed document of
	// this controller, for a route of it. An about:srcdoc document's URL
	// names nothing: its referrer is its parent's address, which the browser
	// wrote on the request under the document's own policy (in full, as the
	// proxy's origin alone, or not at all), and is taken when it is of the
	// origin the document was vouched for (srcdocVouches). A page that names
	// another referrer on such a request names one of its own origin, which
	// it could make its address anyway.
	router.routes.set(
		new RegExp(`^/${FRESH_RETURN_ROUTE}$`),
		async (request, _resolved, context) => {
			const origin = new URL(request.url).origin;
			const prefix = `${origin}${rewriter.directory}`;
			try {
				const to = request.method === 'POST' ? await request.text() : '';
				const id = context?.clientId;
				const client =
					id && typeof clients !== 'undefined'
						? await clients.get(id)
						: undefined;
				let source: string | null = null;
				if (client?.url.startsWith(prefix)) source = client.url;
				else if (
					id &&
					client &&
					(client.url === '' || client.url.startsWith('about:srcdoc'))
				) {
					const referrer =
						request.referrer === 'about:client' ? '' : request.referrer;
					// (none at all names nobody: no vouch is needed for it)
					const bound = referrer === '' ? null : await boundClient(id, true);
					if (referrer === '' || (bound && referrer === `${origin}/`))
						source = referrer;
					else if (
						bound &&
						parseRoutedURL(referrer, rewriter.codec, prefix).url.url.origin ===
							bound.client.origin
					)
						source = referrer;
				}
				if (source !== null && to.startsWith(prefix) && to.length <= 16384)
					rememberFreshReturn(to, source, request.referrerPolicy);
			} catch (error) {
				// no body, a referrer that is no route, or the client is gone:
				// the navigation goes as its parent's
			}
			return new Response(null, {
				status: 204,
				headers: { 'cache-control': 'no-store' },
			});
		},
	);

	// A GET form without an action submits to the document's own address,
	// and the browser writes its fields after the route as they are: the
	// document is answered at its sealed address, as a form with an action
	// is (the html:form route below), so the frame's address and its history
	// entry hold no field in clear
	const documents = router.routes.get(DOCUMENT_ROUTE)!;
	router.routes.set(DOCUMENT_ROUTE, (serverRequest, resolved, context) => {
		const oURL = new URL(serverRequest.url);
		if (serverRequest.method !== 'GET' || !oURL.search)
			return documents(serverRequest, resolved, context);
		const { url } = parseRoutedURL(
			serverRequest.url,
			rewriter.codec,
			`${oURL.origin}${rewriter.directory}`,
		);
		return new Response(undefined, {
			headers: { location: formLocation(serverRequest, oURL, url) },
			status: 307,
		});
	});

	router.routes.set(/^\/html:form(:nested:[^/]*)?\//, async (serverRequest) => {
		const oURL = new URL(serverRequest.url);
		const { url } = parseRoutedURL(
			`${oURL.origin}${oURL.pathname}${fragmentOf(oURL)}`, // exclude query
			rewriter.codec,
			`${oURL.origin}${rewriter.directory}`,
		);

		// a form without fields submits to `action?`, an empty query; a GET
		// form's query comes sealed (the inject's FormQuery module), or as the
		// browser wrote the fields
		url.url = withQuery(url.url, formQuery(rewriter.codec, queryOf(oURL)));

		// a form an https page (or one under an https top) submits to http:
		// warned about, blocked in a nested frame, stopped at Chrome's
		// interstitial at the top; under upgrade-insecure-requests, upgraded
		// (src/mixedContent.ts)
		const nested = nestedTopOf(
			oURL.pathname,
			rewriter.directory,
			rewriter.codec,
		);
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

		return new Response(undefined, {
			headers: { location: formLocation(serverRequest, oURL, url) },
			status: 307,
		});
	});

	registerServiceWorkerScripts(router, rewriter);

	// a document about to navigate another window from that window's realm
	// names itself its initiator (navigationHints.ts NavigationInitiator):
	// who it is is its client, verified to be a routed document of this
	// controller, and its policy is the one the browser gave the request
	router.routes.set(
		new RegExp(`^/${INITIATOR_ROUTE}$`),
		async (serverRequest, _url, context) => {
			const refused = () => new Response(null, { status: 403 });
			if (
				serverRequest.method !== 'POST' ||
				!context?.clientId ||
				typeof clients === 'undefined'
			)
				return refused();
			const prefix = `${new URL(serverRequest.url).origin}${rewriter.directory}`;
			const found = await clients.get(context.clientId);
			if (!found?.url.startsWith(prefix)) return refused();
			let origin: string;
			let target: URL;
			let body: {
				url?: unknown;
				activated?: unknown;
				opaque?: unknown;
				ask?: unknown;
				initiator?: unknown;
			};
			try {
				origin = parseRoutedURL(found.url, rewriter.codec, prefix).url.url
					.origin;
				const text = await serverRequest.text();
				if (text.length > 20000) return refused();
				body = JSON.parse(text);
				target = new URL(String(body.url));
			} catch (error) {
				return refused();
			}
			if (!/^https?:$/.test(target.protocol)) return refused();
			const opaque = body.opaque === true;
			const referrer = opaque ? '' : found.url;
			// the site pool: a frame about to ask a window of another slot to
			// navigate (src/inject/dom/siteAcross.ts) asks what would be
			// recorded of it, which goes with the request; nothing is recorded
			// here, where the navigation does not arrive
			if (body.ask === true)
				return new Response(
					JSON.stringify({ referrer, policy: serverRequest.referrerPolicy }),
					{
						headers: {
							'content-type': 'application/json',
							'cache-control': 'no-store',
						},
					},
				);
			const initiator: NavigationInitiator = {
				referrer,
				policy: serverRequest.referrerPolicy,
				origin: opaque ? 'null' : origin,
				activated: body.activated === true,
			};
			// and the window it asked, navigating itself for it: the frame's
			// route (another slot's, read as the same route on this origin)
			// and policy, as its worker answered them; a frame of another
			// slot is of another site, so its activation counts for nothing
			const told = body.initiator as
				{ referrer?: unknown; policy?: unknown } | null | undefined;
			if (told !== undefined) {
				if (
					typeof told?.referrer !== 'string' ||
					typeof told.policy !== 'string' ||
					told.policy.length > 64
				)
					return refused();
				initiator.policy = told.policy as ReferrerPolicy;
				initiator.activated = false;
				initiator.referrer = '';
				initiator.origin = 'null';
				if (told.referrer)
					try {
						const from = new URL(told.referrer);
						if (!proxyOrigins(rewriter.config).includes(from.origin))
							return refused();
						initiator.referrer = `${new URL(serverRequest.url).origin}${from.pathname}${from.search}`;
						initiator.origin = parseRoutedURL(
							initiator.referrer,
							rewriter.codec,
							prefix,
						).url.url.origin;
					} catch (error) {
						return refused();
					}
			}
			recordNavigationInitiator(target.href, initiator);
			return new Response(null, {
				status: 204,
				headers: { 'cache-control': 'no-store' },
			});
		},
	);

	// todo: parse more request headers
	router.routes.set(
		/^\/xhr\//,
		genericForward(rewriter, undefined, (resource) => routeBinary(resource)),
	);

	return {
		route,
		extensionsServe,
		setRules(rules: RequestRule[]) {
			rewriter.rules = compileRules(rules);
			forgetRecentOutputs();
		},
		hostReloaded(mode: HostReload) {
			rewriter.hostReload = { mode, until: Date.now() + RESTORE_WINDOW_MS };
		},
		hardReloaded(url: string) {
			const reloads = (rewriter.hardReloads ??= new Map());
			const now = Date.now();
			for (const [kept, until] of reloads)
				if (until <= now) reloads.delete(kept);
			reloads.set(url.split('#')[0], now + HISTORY_STEP_MS);
		},
		historyStepped(url: string) {
			const steps = (rewriter.historySteps ??= new Map());
			const now = Date.now();
			for (const [kept, until] of steps) if (until <= now) steps.delete(kept);
			steps.set(url.split('#')[0], now + HISTORY_STEP_MS);
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
	/**
	 * the emulated worker that controls the document the request is for (a
	 * navigation's: the one it makes), as `<registration> <version>`; none
	 * for an uncontrolled one. Natively the renderer's memory cache keeps a
	 * controlled document's loads apart from an uncontrolled one's, and from
	 * another worker's: its key names the controller.
	 */
	controller?: string;
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
					rewriter.codec,
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
	const active = routed.record.active;
	const controller = active ? `${routed.record.id} ${active.id}` : undefined;
	let body: Blob | null;
	try {
		body = (await upload) ?? null;
	} catch (error) {
		// the page's body could not be read: as the network would have
		return { response: null, control: routed.control, controller };
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
		return {
			response: null,
			control: routed.control,
			controller,
			network: answer.network,
		};
	return { response: answer, control: routed.control, controller };
}

/**
 * A request's answer from the service worker of the extension whose page
 * made it (or whose page it navigates to), or null for the package: Chrome's
 * worker controls the extension's pages, never a web page
 * (./extensions/fetchEvents.ts). The worker sees the request at its
 * `chrome-extension://` URL; what it answers is rewritten as the package's
 * file would have been.
 */
async function answerFromExtensionWorker(
	rewriter: Rewriter,
	serverRequest: Request,
	url: StompURL,
	context: RouteContext | undefined,
	upload: Promise<Blob | undefined>,
	referrer: string,
	navigation: boolean,
	destination: string,
	client: URL | null,
): Promise<Response | null> {
	const registry = rewriter.extensions;
	const id =
		registry && !context?.internal
			? workerOf(registry, url.url, navigation, client)
			: null;
	if (!id) return null;
	let body: ArrayBuffer | null;
	try {
		body = (await (await upload)?.arrayBuffer()) ?? null;
	} catch (error) {
		return null;
	}
	return fetchEvents.dispatch(
		rewriter.directory,
		id,
		{
			url: displayExtensionURL(url.url.href),
			method: serverRequest.method,
			headers: [...serverRequest.headers].filter(
				([name]) => !OWN_HEADERS.includes(name),
			),
			body,
			mode: serverRequest.mode,
			credentials: serverRequest.credentials,
			cache: serverRequest.cache,
			redirect: serverRequest.redirect,
			referrer: displayExtensionURL(referrer),
			referrerPolicy: serverRequest.referrerPolicy,
			integrity: serverRequest.integrity,
			keepalive: serverRequest.keepalive,
			destination: destination === 'empty' ? '' : destination,
		},
		navigation ? '' : (context?.clientId ?? ''),
		navigation ? (context?.resultingClientId ?? context?.clientId ?? '') : '',
	);
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
			// its requests are judged by its response's policies, kept with it
			if (context?.resultingClientId && found.policies)
				rememberWorkerPolicies(
					context.resultingClientId,
					url.url,
					found.policies.policies.flatMap(([text, disposition]) =>
						parsePolicies(text, disposition, 'header'),
					),
				);
			const client = helperNames(rewriter.config).client;
			const script =
				modifyJS(
					found.script,
					url,
					rewriter.config,
					found.info.type === 'module' ? 'workerModule' : 'worker',
					`${client}.emulateServiceWorker(${JSON.stringify({ ...found.info, native: nativeServiceWorker() })});` +
						(found.policies
							? `${client}.judgeConnections(${JSON.stringify(found.policies)});`
							: ''),
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
				headers: {
					...SCRIPT_HEADERS,
					// a service worker's imported script reads in its resource
					// timing as its script cache's (measured natively, at its
					// first install too): nothing transferred, no encoded
					// bytes, the script's own decoded
					'server-timing': `${CACHED_MARKER}, ${MEMORY_MARKER}, ${SIZE_MARKER};dur=0;desc=${utf8Length(text)}`,
				},
			});
		},
	);
}
