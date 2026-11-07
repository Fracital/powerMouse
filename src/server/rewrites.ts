import {
	BareCompatibleClient,
	type ProxyTransport,
} from '@mercuryworkshop/proxy-transports';
import { getDomain } from 'tldts';
import GenericCodec from '../Codecs';
import { codecType, Config, ParsedConfig } from '../config';
import { capitalizeHeaders, rewriteLinkHeader } from '../headers';
import { modifyCSS, routeCSS } from '../rewriteCSS';
import { modifyHTML, modifyRefresh, routeHTML } from '../rewriteHTML';
import { modifyJS, routeJS, ScriptType } from '../rewriteJS';
import { parseRoutedURL, routeBinary } from '../routeURL';
import StompURL from '../StompURL';
import type { RequestInfo, RouteContext } from '../transport/messages';
import { BUILD } from '../version';
import { HttpCache, isCacheable } from './cache';
import { decodeDocument, utf8ContentType } from './charset';
import Cookies, { CookieRequestContext } from './Cookies';
import {
	AdditionalFilter,
	filterNativeRequestHeaders,
	filterResponseHeaders,
	RouteTransform,
} from './filterHeaders';
import Router from './Router';

export const statusEmpty = [101, 204, 205, 304];

const integrityHeaders: string[] = ['Content-MD5'];

declare const clients: Clients | undefined;

const DEFAULT_REFERRER_POLICY = 'strict-origin-when-cross-origin';

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
	cookies: Cookies;
	/** the HTTP cache, unless the host turned it off */
	cache?: HttpCache;
	/** the host's request log, when it asked for one */
	log?: (info: RequestInfo) => void;
}

function genericForward(
	rewriter: Rewriter,
	transformBody: BodyTransform | void,
	transformRoute: RouteTransform,
	additionalRequestFilter: AdditionalFilter | void,
	additionalResponseFilter: AdditionalFilter | void,
) {
	return async function (
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
		// destination counts as a navigation: a cross-site link into a site
		// that keeps its login in Lax cookies still works, at the price of
		// nested cross-site iframes getting Lax cookies a browser would withhold
		requestHeaders.set(
			'cookie',
			(
				await rewriter.cookies.get(url.url, {
					site: site as CookieRequestContext['site'],
					navigation: destination === 'document' || destination === 'iframe',
					method: serverRequest.method,
				})
			).toString(),
		);

		// the HTTP cache, unless the host turned it off: a fresh entry answers
		// without the transport; a stale one with validators is revalidated
		// and a 304 refreshes it; what comes back cacheable is stored (its
		// body split in two, one copy for the store)
		const cache = rewriter.cache;
		const hit =
			cache &&
			(serverRequest.method === 'GET' || serverRequest.method === 'HEAD')
				? await cache.match(url.toString(), requestHeaders)
				: null;
		let response: Response & { rawHeaders?: [string, string][] };
		let cached = false;
		if (hit && hit.fresh && !hit.mustRevalidate) {
			response = hit.response;
			cached = true;
		} else {
			if (hit) {
				if (hit.etag) requestHeaders.set('if-none-match', hit.etag);
				if (hit.lastModified)
					requestHeaders.set('if-modified-since', hit.lastModified);
			}
			let upstream: Awaited<ReturnType<typeof rewriter.bare.fetch>>;
			try {
				upstream = await rewriter.bare.fetch(url.toString(), {
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
					headers: capitalizeHeaders(requestHeaders),
				});
			} catch (error) {
				rewriter.log?.({
					url: url.toString(),
					method: serverRequest.method,
					destination: serverRequest.destination,
					status: 0,
					ms: Date.now() - started,
					cached: false,
					bytes: null,
					error: String(error),
					client: context?.clientId,
				});
				throw error;
			}
			if (hit && upstream.status === 304) {
				response = await cache!.refresh(url.toString(), hit, upstream.headers);
			} else if (
				cache &&
				upstream.body &&
				isCacheable({
					method: serverRequest.method,
					requestHeaders,
					status: upstream.status,
					responseHeaders: upstream.headers,
				})
			) {
				const [forStore, forPage] = upstream.body.tee();
				cache.put(url.toString(), requestHeaders, upstream, forStore);
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

		if (rewriter.log) {
			const length = Number(response.headers.get('content-length'));
			rewriter.log({
				url: url.toString(),
				method: serverRequest.method,
				destination: serverRequest.destination,
				status: response.status,
				ms: Date.now() - started,
				cached,
				bytes: Number.isFinite(length) ? length : null,
				client: context?.clientId,
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
				await rewriter.cookies.set(value, url.url);
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
				build: BUILD,
			};
		},
		cookies,
		cache,
		log,
		codec: init.codec,
		directory: init.directory,
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
			async (url, response) =>
				response.ok && modifyCSS(await response.text(), url),
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
		/^\/html\//,
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

	router.routes.set(/^\/html:form\//, (serverRequest) => {
		const oURL = new URL(serverRequest.url);
		const { url } = parseRoutedURL(
			`${oURL.origin}${oURL.pathname}${oURL.hash}`, // exclude query
			rewriter.codec,
			`${oURL.origin}${rewriter.directory}`,
		);

		url.url.search = oURL.search;

		return new Response(undefined, {
			headers: {
				location: routeHTML(url, url, rewriter.config),
			},
			status: 307,
		});
	});

	// todo: parse more request headers
	router.routes.set(
		/^\/xhr\//,
		genericForward(rewriter, undefined, (resource) => routeBinary(resource)),
	);

	return { route };
}
