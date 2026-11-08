import {
	BareCompatibleClient,
	type ProxyTransport,
} from '@mercuryworkshop/proxy-transports';
import { getDomain } from 'tldts';
import GenericCodec from '../Codecs';
import { codecType, Config, ParsedConfig } from '../config';
import { capitalizeHeaders, rewriteLinkHeader } from '../headers';
import {
	DEFAULT_REFERRER_POLICY,
	refererFor,
	type ReferrerInfo,
} from '../referrerPolicy';
import { modifyCSS, rewriteCSSValueURLs, routeCSS } from '../rewriteCSS';
import {
	modifyHTML,
	modifyRefresh,
	modifyXML,
	nestedTopOf,
	routeHTML,
	XML_DOCUMENT_MIMES,
} from '../rewriteHTML';
import { modifyJS, routeJS, ScriptType } from '../rewriteJS';
import { parseRoutedURL, routeBinary, unwrapRoute } from '../routeURL';
import StompURL from '../StompURL';
import type {
	RequestErrorKind,
	RequestInfo,
	RequestRule,
	RouteContext,
} from '../transport/messages';
import { ABORT_HEADER } from '../transport/messages';
import { BUILD } from '../version';
import { HttpCache, isCacheable, mayKeep } from './cache';
import { decodeDocument, utf8ContentType } from './charset';
import Cookies from './Cookies';
import { DOCUMENT_DESTINATIONS, hostErrorPage } from './errorPage';
import {
	AdditionalFilter,
	filterNativeRequestHeaders,
	filterResponseHeaders,
	RouteTransform,
} from './filterHeaders';
import { takeInline } from './inline';
import type { RewriteCache, RewriteCacheOutcome } from './rewriteCache';
import Router from './Router';
import { applyHeaderRule, CompiledRule, compileRules } from './rules';

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
function siteBetween(from: URL, to: URL): Site {
	if (from.origin === to.origin) return 'same-origin';
	if (from.protocol !== to.protocol) return 'cross-site';
	const domain = getDomain(from.hostname, { allowPrivateDomains: true });
	return (domain !== null &&
		domain === getDomain(to.hostname, { allowPrivateDomains: true })) ||
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

/**
 * Chrome sends fetch metadata to potentially trustworthy URLs only: https
 * (and wss), and the loopback hosts it treats as secure. A plain http
 * origin anywhere else gets none.
 */
function potentiallyTrustworthy(url: URL): boolean {
	if (url.protocol === 'https:' || url.protocol === 'wss:') return true;
	const host = url.hostname;
	return (
		host === 'localhost' ||
		host.endsWith('.localhost') ||
		host === '[::1]' ||
		/^127(\.\d{1,3}){3}$/.test(host)
	);
}

/**
 * The real URL of each service worker client, by id: a request's origin is
 * its client's (a stylesheet's font, a module's import and a worker's fetch
 * all come from the document or worker that started them), while the
 * Referer names the stylesheet or module. A client keeps its origin for
 * life (pushState cannot change it), so one lookup per client is enough.
 */
const clientURLs = new Map<string, URL>();
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
}
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

const BODY_ILLEGAL = ['GET', 'HEAD'];

type BodyTransform = (
	url: StompURL,
	response: Response,
	responseHeaders: Headers,
	referrer: ReferrerInfo,
	/** the request as it went upstream (its method, its final headers) */
	request: { method: string; headers: Headers },
	/** what the transform tells the request log */
	note: { rewriteCache?: RewriteCacheOutcome },
) => Promise<BodyInit | false>;

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
	/** the host's request log, when it asked for one */
	log?: (info: RequestInfo) => void;
	/** the host's request rules, compiled */
	rules: CompiledRule[];
}

/** the page aborted the request (its signal fired) */
const ABORTED = Symbol('aborted');

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

		requestHeaders.set('user-agent', navigator.userAgent);

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
				requestHeaders.set(
					name,
					parseRoutedURL(
						value,
						rewriter.codec,
						`${oURL.origin}${rewriter.directory}`,
					).url.toString(),
				);
			} catch (error) {
				requestHeaders.delete(name);
			}
		}
		const destination = serverRequest.destination || 'empty';
		const navigation = serverRequest.mode === 'navigate';
		const nestedRoute = nestedTopOf(oURL.pathname, rewriter.directory);
		// every proxied page arrives here as an iframe (the host's frame): a
		// document the page did not route as nested (an iframe of its own, or
		// a navigation from inside one) is a top-level one
		const topLevel =
			destination === 'document' ||
			(destination === 'iframe' && nestedRoute === null);
		const policy = serverRequest.referrerPolicy || DEFAULT_REFERRER_POLICY;

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
			serverRequest.referrer && serverRequest.referrer !== 'about:client'
				? serverRequest.referrer
				: null;

		// the request's client, by its real URL. Never for a navigation: its
		// client id is the document being created, and asking for it would
		// wait on this very response
		let client: URL | null = null;
		if (!navigation && context?.clientId && typeof clients !== 'undefined') {
			const id = context.clientId;
			client = clientURLs.get(id) ?? null;
			if (!client)
				try {
					const found = await clients.get(id);
					client = found ? decode(found.url) : null;
				} catch (error) {
					// the client is gone
				}
			if (client && !clientURLs.has(id)) {
				if (clientURLs.size >= CLIENT_URLS_KEPT)
					clientURLs.delete(clientURLs.keys().next().value!);
				clientURLs.set(id, client);
			}
		}

		// the Referer's source: the browser's routed Referer decoded, when it
		// kept the full URL; when the policy made it send the proxy origin
		// only (origin, strict-origin) the client stands in, since only its
		// origin is sent then
		let refererSource = referrer ? decode(referrer) : null;
		if (!refererSource && referrer === `${oURL.origin}/`)
			refererSource = client;

		// a redirect this worker answered earlier in the same chain decided
		// the referrer already: the next hop starts from that (stripped) value
		const hopClient = navigation ? '' : (context?.clientId ?? '');
		const previousHop = takeRedirect(
			hopClient,
			serverRequest.referrer,
			serverRequest.url,
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
		const initiator =
			client ??
			refererSource ??
			(navigation && nestedRoute ? new URL(nestedRoute) : null);
		const sameOrigin =
			initiator !== null && initiator.origin === url.url.origin;

		// the browser sends Origin on cross-origin CORS requests and on every
		// request with a body
		if (
			initiator &&
			((!sameOrigin && serverRequest.mode === 'cors') ||
				!BODY_ILLEGAL.includes(serverRequest.method))
		)
			requestHeaders.set('origin', initiator.origin);

		// Sec-Fetch-Site: `none` for a navigation nobody in a page started (the
		// host's, which the user typed or picked); a subresource whose client
		// is not a proxied page (a blob: worker) is taken as its target's own,
		// the benefit the credentials mode gives it too
		let site: Site = initiator
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
		const cookieSite = nestedTop
			? widestSite(site, siteBetween(new URL(nestedTop), url.url))
			: site;

		// the chain's earlier hops count for the site (Sec-Fetch-Site only:
		// the browser's site for cookies does not follow redirects)
		if (previousHop && site !== 'none')
			site = widestSite(previousHop.site, site);

		if (potentiallyTrustworthy(url.url)) {
			requestHeaders.set('sec-fetch-site', site);
			requestHeaders.set(
				'sec-fetch-mode',
				serverRequest.mode || (destination === 'empty' ? 'cors' : 'no-cors'),
			);
			requestHeaders.set(
				'sec-fetch-dest',
				navigation && topLevel ? 'document' : destination,
			);
			// only a navigation the user started: the host's (typed, picked).
			// One a page started under user activation would carry it too,
			// but the worker cannot see the page's activation
			if (navigation && topLevel && site === 'none')
				requestHeaders.set('sec-fetch-user', '?1');
		}

		// the request's credentials mode, as the browser would apply it to its
		// own jar: `omit` sends and stores no cookies, `same-origin` only when
		// the initiator's real origin is the target's (every proxied request
		// looks same-origin to the browser, so this is decided here; an
		// unknown initiator is given the benefit), `include` always
		const credentials =
			serverRequest.credentials === 'omit'
				? false
				: serverRequest.credentials === 'same-origin'
					? initiator === null || sameOrigin
					: true;
		if (credentials)
			requestHeaders.set(
				'cookie',
				(
					await rewriter.cookies.get(url.url, {
						site: cookieSite,
						navigation: topLevel,
						method: serverRequest.method,
					})
				).toString(),
			);
		else requestHeaders.delete('cookie');

		// the host's rules, on the real request as it would go out: the first
		// match blocks, answers, redirects or edits headers. Before the cache
		// (a blocked or redirected request never touches it) and logged as such
		const rule = rewriter.rules.find((candidate) =>
			candidate.matches(url.url, serverRequest.method, destination, site),
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
							nestedTopOf(oURL.pathname, rewriter.directory) ?? false,
						),
					},
					'redirected by a rule',
				);
			applyHeaderRule(requestHeaders, rule.action.requestHeaders);
		}

		// the HTTP cache, unless the host turned it off: a fresh entry answers
		// without the transport; a stale one with validators is revalidated
		// and a 304 refreshes it; what comes back cacheable is stored (its
		// body split in two, one copy for the store). Stale entries are used
		// only as far as the origin allowed: within stale-while-revalidate
		// they answer at once and one revalidation runs behind the page; within
		// stale-if-error they answer for a 5xx or a failed request. Never any
		// freshness the origin did not state.
		const cache = rewriter.cache;
		const hit =
			cache &&
			(serverRequest.method === 'GET' || serverRequest.method === 'HEAD')
				? await cache.match(url.toString(), requestHeaders)
				: null;
		let response: Response & { rawHeaders?: [string, string][] };
		let cached = false;
		const within = (window: number | null) =>
			!!hit && !hit.mustRevalidate && window !== null && hit.staleFor <= window;
		const fetchUpstream = (headers: Headers) => {
			const upstream = rewriter.bare.fetch(url.toString(), {
				method: serverRequest.method,
				redirect: 'manual',
				// redirect: serverRequest.redirect,
				// the body goes through as the stream it is (the port transfers
				// it, the transport accepts it): an upload is never held in the
				// service worker's memory
				body:
					(!BODY_ILLEGAL.includes(serverRequest.method) &&
						serverRequest.body) ||
					undefined,
				headers: capitalizeHeaders(headers),
			});
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
		const withValidators = (headers: Headers) => {
			const conditional = new Headers(headers);
			if (hit?.etag) conditional.set('if-none-match', hit.etag);
			if (hit?.lastModified)
				conditional.set('if-modified-since', hit.lastModified);
			return conditional;
		};
		const storable = (status: number, responseHeaders: Headers) =>
			!!cache &&
			isCacheable({
				method: serverRequest.method,
				requestHeaders,
				status,
				responseHeaders,
			});

		if (hit && hit.fresh && !hit.mustRevalidate) {
			response = hit.response;
			cached = true;
		} else if (hit && within(hit.staleWhileRevalidate)) {
			response = hit.response;
			cached = true;
			// one revalidation per URL, however many stale hits arrive together
			cache!.revalidateOnce(url.toString(), async () => {
				const upstream = await fetchUpstream(withValidators(requestHeaders));
				if (upstream.status === 304)
					await cache!.refresh(url.toString(), hit, upstream.headers);
				else if (upstream.body && storable(upstream.status, upstream.headers))
					await cache!.put(
						url.toString(),
						requestHeaders,
						upstream,
						upstream.body,
					);
				else await upstream.body?.cancel();
			});
		} else {
			let upstream: Awaited<ReturnType<typeof rewriter.bare.fetch>> | null =
				null;
			try {
				upstream = await fetchUpstream(withValidators(requestHeaders));
			} catch (error) {
				if (error === ABORTED) {
					reportAborted();
					return Response.error();
				}
				if (!within(hit?.staleIfError ?? null)) {
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
			}
			if (
				upstream === null ||
				(upstream.status >= 500 && within(hit?.staleIfError ?? null))
			) {
				// the origin failed (or could not be reached) and allowed a stale
				// answer for that: the entry, marked by its Age
				await upstream?.body?.cancel();
				response = hit!.response;
				cached = true;
			} else if (hit && upstream.status === 304) {
				response = await cache!.refresh(url.toString(), hit, upstream.headers);
			} else if (upstream.body && storable(upstream.status, upstream.headers)) {
				const [forStore, forPage] = upstream.body.tee();
				cache!.put(url.toString(), requestHeaders, upstream, forStore);
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

		if (rule && rule.action !== 'block' && rule.action.responseHeaders) {
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

		// the report is made now (its time is to the headers) and sent once the
		// body's transform has said how it went
		const note: { rewriteCache?: RewriteCacheOutcome } = {};
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
				});
			report = null;
		};

		const responseHeaders = filterResponseHeaders(
			response.headers,
			url,
			transformRoute,
			additionalResponseFilter,
		);

		// the browser follows the redirect in proxy URL space, where every hop
		// is same-origin and the referrer never narrows: remember what this hop
		// sent and its site, so a chain through another origin keeps both
		if (
			REDIRECT_STATUSES.includes(response.status) &&
			responseHeaders.has('location')
		)
			rememberRedirect(
				hopClient,
				serverRequest.referrer,
				responseHeaders.get('location')!,
				serverRequest.url,
				carried !== undefined || refererSource ? { referer, site } : { site },
			);

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
				if (credentials) await rewriter.cookies.set(value, url.url);
			}
		}

		let body: BodyInit | undefined;

		if (statusEmpty.includes(+response.status)) {
			body = undefined;
		} else {
			let transformed: BodyInit | false;
			try {
				transformed = transformBody
					? await transformBody(
							url,
							response,
							responseHeaders,
							referrerInfo,
							{ method: serverRequest.method, headers: requestHeaders },
							note,
						)
					: false;
			} catch (error) {
				sendReport();
				throw error;
			}

			body = transformed !== false ? transformed : response.body!;

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

const htmlMimes = ['text/html', '', ...XML_DOCUMENT_MIMES];

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
) {
	const rewriter: Rewriter = {
		get config() {
			return {
				directory: this.directory,
				scope: init.scope,
				codec: codecType(this.codec),
				frameAncestors: init.frameAncestors,
				...(init.openTab ? { openTab: true } : {}),
				// the pages' synchronous requests complete (a written script in
				// a document no worker controls is copied at once)
				...(init.workerTransport ? { workerTransport: true } : {}),
				...(init.allowInvalidJs === false ? { allowInvalidJs: false } : {}),
				...(init.assets ? { assets: init.assets } : {}),
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
		log,
		rules: [],
		codec: init.codec,
		directory: init.directory,
		errorPage: init.errorPage,
		names: init.names,
		bare: new BareCompatibleClient(transport),
	};

	router.routes.set(
		/^\/binary\//,
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
	const scriptTypeFactory = (type: ScriptType) =>
		genericForward(
			rewriter,
			async (url, response, _headers, _referrer, request, note) => {
				if (!response.ok) return false;
				const text = await response.text();
				const rewrites = rewriter.rewrites;
				if (
					!rewrites ||
					!mayKeep({
						method: request.method,
						requestHeaders: request.headers,
						status: response.status,
						responseHeaders: response.headers,
					})
				) {
					note.rewriteCache = 'skip';
					return modifyJS(text, url, rewriter.config, type);
				}
				const key = await rewrites.key(
					[
						BUILD,
						url.toString(),
						type,
						JSON.stringify(rewriter.config),
						url.codec.key,
					],
					text,
				);
				const kept = await rewrites.match(key);
				if (kept !== null) {
					note.rewriteCache = 'hit';
					return kept;
				}
				const output = modifyJS(text, url, rewriter.config, type);
				await rewrites.put(key, output);
				note.rewriteCache = 'miss';
				return output;
			},
			(resource, url) => routeJS(resource, url, rewriter.config, type),
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
	router.routes.set(/^\/js:worker\//, scriptTypeFactory('worker'));
	router.routes.set(/^\/js:workerModule\//, scriptTypeFactory('workerModule'));

	router.routes.set(
		/^\/css\//,
		genericForward(
			rewriter,
			async (url, response) => {
				if (!response.ok) return false;
				const text = await response.text();
				try {
					return modifyCSS(text, url);
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
				modifyHTML(entry.markup, url, rewriter.config, true),
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
			async (url, response, responseHeaders, referrer) => {
				const contentType = responseHeaders.get('content-type');
				const mime = getMime(contentType || '');
				if (!htmlMimes.includes(mime)) return false;
				// decode the way the browser would have (BOM, header charset,
				// <meta charset>), then serve the rewritten document as UTF-8
				const bytes = new Uint8Array(await response.arrayBuffer());
				responseHeaders.set('content-type', utf8ContentType(contentType));
				// an XML document (a standalone SVG, an XHTML page) keeps its mime
				// and gets an XML shell: the HTML one is not well-formed XML
				if (XML_DOCUMENT_MIMES.includes(mime))
					return modifyXML(
						decodeDocument(bytes, contentType),
						url,
						rewriter.config,
						mime,
						referrer,
					);
				// A Refresh header schedules its navigation on the document the
				// browser creates for this response, which the shell re-opens to
				// write the page: the re-open drops it. The same value as a meta
				// refresh in the markup lands in the written document instead, and
				// the inject routes it like any meta refresh the page wrote.
				let markup = decodeDocument(bytes, contentType);
				const refresh = response.headers.get('refresh');
				if (refresh !== null) {
					responseHeaders.delete('refresh');
					markup = withRefreshMeta(markup, refresh);
				}
				return modifyHTML(markup, url, rewriter.config, false, referrer);
			},
			(resource, url) => routeHTML(resource, url, rewriter.config),
			undefined,
			(headers, filteredHeaders, url) => {
				if (headers.has('x-frame-options')) {
					filteredHeaders.delete('x-frame-options');
				}

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

	router.routes.set(/^\/html:form(:nested:[^/]*)?\//, (serverRequest) => {
		const oURL = new URL(serverRequest.url);
		const { url } = parseRoutedURL(
			`${oURL.origin}${oURL.pathname}${oURL.hash}`, // exclude query
			rewriter.codec,
			`${oURL.origin}${rewriter.directory}`,
		);

		url.url.search = oURL.search;

		return new Response(undefined, {
			headers: {
				location: routeHTML(
					url,
					url,
					rewriter.config,
					false,
					nestedTopOf(oURL.pathname, rewriter.directory) ?? false,
				),
			},
			status: 307,
		});
	});

	// todo: parse more request headers
	router.routes.set(
		/^\/xhr\//,
		genericForward(rewriter, undefined, (resource) => routeBinary(resource)),
	);

	return {
		route,
		setRules(rules: RequestRule[]) {
			rewriter.rules = compileRules(rules);
		},
	};
}
