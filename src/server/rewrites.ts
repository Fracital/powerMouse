import {
	BareCompatibleClient,
	type ProxyTransport,
} from '@mercuryworkshop/proxy-transports';
import { getDomain } from 'tldts';
import GenericCodec from '../Codecs';
import { codecType, Config, ParsedConfig } from '../config';
import { capitalizeHeaders, rewriteLinkHeader } from '../headers';
import { modifyCSS, rewriteCSSValueURLs, routeCSS } from '../rewriteCSS';
import {
	modifyHTML,
	modifyRefresh,
	nestedTopOf,
	routeHTML,
} from '../rewriteHTML';
import { modifyJS, routeJS, ScriptType } from '../rewriteJS';
import { parseRoutedURL, routeBinary } from '../routeURL';
import StompURL from '../StompURL';
import type {
	RequestErrorKind,
	RequestInfo,
	RequestRule,
	RouteContext,
} from '../transport/messages';
import { BUILD } from '../version';
import { HttpCache, isCacheable } from './cache';
import { decodeDocument, utf8ContentType } from './charset';
import Cookies, { CookieRequestContext } from './Cookies';
import { DOCUMENT_DESTINATIONS, hostErrorPage } from './errorPage';
import {
	AdditionalFilter,
	filterNativeRequestHeaders,
	filterResponseHeaders,
	RouteTransform,
} from './filterHeaders';
import Router from './Router';
import { applyHeaderRule, CompiledRule, compileRules } from './rules';

export const statusEmpty = [101, 204, 205, 304];

const integrityHeaders: string[] = ['Content-MD5'];

declare const clients: Clients | undefined;

const DEFAULT_REFERRER_POLICY = 'strict-origin-when-cross-origin';

/** the real URL a request is reported as: without the `#url(...)` fragment the CSS rewriter keeps for idempotence */
function reportURL(url: StompURL): string {
	const text = url.toString();
	const marker = text.indexOf('#url(');
	return marker === -1 ? text : text.slice(0, marker);
}

type Site = 'none' | 'same-origin' | 'same-site' | 'cross-site';

/** the fetch-metadata site between two real URLs */
function siteBetween(from: URL, to: URL): Site {
	if (from.origin === to.origin) return 'same-origin';
	const domain = getDomain(from.hostname);
	return (domain !== null && domain === getDomain(to.hostname)) ||
		from.hostname === to.hostname
		? 'same-site'
		: 'cross-site';
}

/** the more distant of two sites ('none' counts as the closest) */
function widestSite(a: string, b: Site): Site {
	const order: Site[] = ['none', 'same-origin', 'same-site', 'cross-site'];
	return order[Math.max(order.indexOf(a as Site), order.indexOf(b))];
}

/**
 * The Referer a browser sends from `source` to `target` under `policy`
 * (Referrer Policy, "determine request's referrer"), for the real origins.
 * Null means no header.
 */
function refererFor(source: URL, target: URL, policy: string): string | null {
	const sameOrigin = source.origin === target.origin;
	const downgrade =
		source.protocol === 'https:' && target.protocol !== 'https:';
	const full = () => {
		const stripped = new URL(source);
		stripped.hash = '';
		stripped.username = '';
		stripped.password = '';
		return stripped.toString();
	};
	const origin = () => `${source.origin}/`;
	switch (policy) {
		case 'no-referrer':
			return null;
		case 'unsafe-url':
			return full();
		case 'origin':
			return origin();
		case 'same-origin':
			return sameOrigin ? full() : null;
		case 'strict-origin':
			return downgrade ? null : origin();
		case 'no-referrer-when-downgrade':
			return downgrade ? null : full();
		case 'origin-when-cross-origin':
			return sameOrigin ? full() : origin();
		default:
			// strict-origin-when-cross-origin
			return sameOrigin ? full() : downgrade ? null : origin();
	}
}

const BODY_ILLEGAL = ['GET', 'HEAD'];

type BodyTransform = (
	url: StompURL,
	response: Response,
	responseHeaders: Headers,
) => Promise<BodyInit | false>;

interface Rewriter {
	codec: GenericCodec;
	directory: string;
	bare: BareCompatibleClient;
	config: Config;
	/** the host's error page, worker-only (never in the page's config) */
	errorPage?: string;
	cookies: Cookies;
	/** the HTTP cache, unless the host turned it off */
	cache?: HttpCache;
	/** the host's request log, when it asked for one */
	log?: (info: RequestInfo) => void;
	/** the host's request rules, compiled */
	rules: CompiledRule[];
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
		const oURL = new URL(serverRequest.url);
		const { url } = parseRoutedURL(
			serverRequest.url,
			rewriter.codec,
			`${oURL.origin}${rewriter.directory}`,
		);

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

		requestHeaders.set('user-agent', navigator.userAgent);

		// Referer, Origin and the fetch metadata are forbidden headers, so the
		// service worker never sees the page's; rebuild them from the initiator
		// the way the browser would for the real origins, under the request's
		// own referrer policy (request.referrerPolicy: the browser derived it
		// from the document's Referrer-Policy header, its meta tag, the
		// element's attribute or fetch's init). The browser's own Referer is a
		// source of truth for the initiator only, never for the reduction: in
		// proxy URL space every proxied request looks same-origin to it.
		requestHeaders.delete('referer');
		requestHeaders.delete('origin');
		const destination = serverRequest.destination || 'empty';
		requestHeaders.set('sec-fetch-dest', destination);
		requestHeaders.set(
			'sec-fetch-mode',
			destination === 'document' || destination === 'iframe'
				? 'navigate'
				: destination === 'empty'
					? 'cors'
					: 'no-cors',
		);
		requestHeaders.delete('sec-fetch-user');
		let site = 'none';
		const policy = serverRequest.referrerPolicy || DEFAULT_REFERRER_POLICY;

		// the initiator: the browser's routed Referer decoded, when it kept the
		// full URL; when the policy made it send the proxy origin only (origin,
		// strict-origin) the document is the request's client
		let initiator: URL | null = null;
		const routedPrefix = `${oURL.origin}${rewriter.directory}`;
		if (serverRequest.referrer && serverRequest.referrer !== 'about:client') {
			try {
				initiator = parseRoutedURL(
					serverRequest.referrer,
					rewriter.codec,
					routedPrefix,
				).url.url;
			} catch (error) {
				// not a routed URL: the proxy origin alone, or the controller page
			}
			// never for a navigation: its client id is the document being created,
			// and asking for it would wait on this very response
			if (
				!initiator &&
				serverRequest.mode !== 'navigate' &&
				serverRequest.referrer === `${oURL.origin}/` &&
				context?.clientId &&
				typeof clients !== 'undefined'
			)
				try {
					const client = await clients.get(context.clientId);
					if (client)
						initiator = parseRoutedURL(client.url, rewriter.codec, routedPrefix)
							.url.url;
				} catch (error) {
					// the client is gone or not a proxied page
				}
		}

		if (initiator) {
			const sameOrigin = initiator.origin === url.url.origin;
			const referer = refererFor(initiator, url.url, policy);
			if (referer) requestHeaders.set('referer', referer);

			// the browser sends Origin on cross-origin fetches and on every
			// request with a body
			if (
				(!sameOrigin && destination === 'empty') ||
				!BODY_ILLEGAL.includes(serverRequest.method)
			)
				requestHeaders.set('origin', initiator.origin);

			site = sameOrigin
				? 'same-origin'
				: getDomain(initiator.hostname) !== null &&
					  getDomain(initiator.hostname) === getDomain(url.url.hostname)
					? 'same-site'
					: 'cross-site';
		}
		requestHeaders.set('sec-fetch-site', site);

		// the jar applies SameSite against the request's site. Every proxied
		// page arrives here as an iframe (the host's frame), so an iframe
		// destination counts as a top-level navigation unless the page routed
		// it as a nested document (an iframe of its own, or a navigation from
		// inside one): a cross-site link into a site that keeps its login in
		// Lax cookies still works, a nested cross-site frame gets None only
		// a nested document's requests are judged by the top-level page as
		// well (the browser's site for cookies and Sec-Fetch-Site walk the
		// ancestors): the route kind of the navigation, or of the referrer
		// when a nested document is the initiator, names that top origin
		const nestedTop =
			nestedTopOf(oURL.pathname, rewriter.directory) ??
			(serverRequest.referrer && serverRequest.referrer !== 'about:client'
				? nestedTopOf(
						new URL(serverRequest.referrer).pathname,
						rewriter.directory,
					)
				: null);
		if (nestedTop) {
			site = widestSite(site, siteBetween(new URL(nestedTop), url.url));
			requestHeaders.set('sec-fetch-site', site);
		}
		const nested = nestedTopOf(oURL.pathname, rewriter.directory) !== null;
		// the request's credentials mode, as the browser would apply it to its
		// own jar: `omit` sends and stores no cookies, `same-origin` only when
		// the initiator's real origin is the target's (every proxied request
		// looks same-origin to the browser, so this is decided here; an
		// unknown initiator is given the benefit), `include` always
		const credentials =
			serverRequest.credentials === 'omit'
				? false
				: serverRequest.credentials === 'same-origin'
					? initiator === null || initiator.origin === url.url.origin
					: true;
		if (credentials)
			requestHeaders.set(
				'cookie',
				(
					await rewriter.cookies.get(url.url, {
						site: site as CookieRequestContext['site'],
						navigation:
							destination === 'document' ||
							(destination === 'iframe' && !nested),
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
		const fetchUpstream = (headers: Headers) =>
			rewriter.bare.fetch(url.toString(), {
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

		if (rewriter.log) {
			const length = Number(response.headers.get('content-length'));
			rewriter.log({
				url: reportURL(url),
				method: serverRequest.method,
				destination: serverRequest.destination || 'fetch',
				status: response.status,
				ms: Date.now() - started,
				cached,
				bytes: Number.isFinite(length) ? length : null,
				client: context?.clientId,
				...(rule ? { rule: rule.index } : {}),
			});
		}

		const responseHeaders = filterResponseHeaders(
			response.headers,
			url,
			transformRoute,
			additionalResponseFilter,
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
			const transformed = transformBody
				? await transformBody(url, response, responseHeaders)
				: false;

			body = transformed !== false ? transformed : response.body!;
		}

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
		try {
			return await forward(serverRequest, resolved, context);
		} catch (error) {
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
		}
	};
}

const htmlMimes = ['image/svg+xml', 'text/html', ''];

export function getMime(contentType: string): string {
	return contentType.split(';')[0];
}

export function registerRewrites(
	router: Router,
	init: ParsedConfig,
	cookies: Cookies,
	transport: ProxyTransport,
	cache?: HttpCache,
	log?: (info: RequestInfo) => void,
) {
	const rewriter: Rewriter = {
		get config() {
			return {
				directory: this.directory,
				codec: codecType(this.codec),
				frameAncestors: init.frameAncestors,
				...(init.openTab ? { openTab: true } : {}),
				...(init.allowInvalidJs === false ? { allowInvalidJs: false } : {}),
				...(init.assets ? { assets: init.assets } : {}),
				build: BUILD,
			};
		},
		cookies,
		cache,
		log,
		rules: [],
		codec: init.codec,
		directory: init.directory,
		errorPage: init.errorPage,
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

	const scriptTypeFactory = (type: ScriptType) =>
		genericForward(
			rewriter,
			async (url, response) =>
				response.ok &&
				modifyJS(await response.text(), url, rewriter.config, type),
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

	router.routes.set(
		/^\/html(:nested:[^/]*)?\//,
		genericForward(
			rewriter,
			async (url, response, responseHeaders) => {
				const contentType = responseHeaders.get('content-type');
				if (!htmlMimes.includes(getMime(contentType || ''))) return false;
				// decode the way the browser would have (BOM, header charset,
				// <meta charset>), then serve the rewritten document as UTF-8
				const bytes = new Uint8Array(await response.arrayBuffer());
				responseHeaders.set('content-type', utf8ContentType(contentType));
				return modifyHTML(
					decodeDocument(bytes, contentType),
					url,
					rewriter.config,
				);
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
