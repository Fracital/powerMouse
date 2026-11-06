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
import { BUILD } from '../version';
import { decodeDocument, utf8ContentType } from './charset';
import Cookies from './Cookies';
import {
	AdditionalFilter,
	filterNativeRequestHeaders,
	filterResponseHeaders,
	RouteTransform,
} from './filterHeaders';
import Router from './Router';

export const statusEmpty = [101, 204, 205, 304];

const integrityHeaders: string[] = ['Content-MD5'];

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
}

function genericForward(
	rewriter: Rewriter,
	transformBody: BodyTransform | void,
	transformRoute: RouteTransform,
	additionalRequestFilter: AdditionalFilter | void,
	additionalResponseFilter: AdditionalFilter | void,
) {
	return async function (serverRequest: Request): Promise<Response> {
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

		requestHeaders.set(
			'cookie',
			(await rewriter.cookies.get(url.url)).toString(),
		);

		// Referer, Origin and the fetch metadata are forbidden headers, so the
		// service worker never sees the page's; rebuild them from the (proxied)
		// referrer the way the browser would for the real origins. The referrer
		// follows the default policy (strict-origin-when-cross-origin): the
		// page's own Referrer-Policy is not known here.
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

		if (serverRequest.referrer && serverRequest.referrer !== 'about:client') {
			try {
				const referrer = parseRoutedURL(
					serverRequest.referrer,
					rewriter.codec,
					`${oURL.origin}${rewriter.directory}`,
				).url.url;
				const sameOrigin = referrer.origin === url.url.origin;
				const downgrade =
					referrer.protocol === 'https:' && url.url.protocol !== 'https:';

				if (sameOrigin) {
					referrer.hash = '';
					requestHeaders.set('referer', referrer.toString());
				} else if (!downgrade)
					requestHeaders.set('referer', `${referrer.origin}/`);

				// the browser sends Origin on cross-origin fetches and on every
				// request with a body
				if (
					(!sameOrigin && destination === 'empty') ||
					!BODY_ILLEGAL.includes(serverRequest.method)
				)
					requestHeaders.set('origin', referrer.origin);

				site = sameOrigin
					? 'same-origin'
					: getDomain(referrer.hostname) !== null &&
						  getDomain(referrer.hostname) === getDomain(url.url.hostname)
						? 'same-site'
						: 'cross-site';
			} catch (error) {
				// referrer isn't a proxied URL (e.g. the controller page)
			}
		}
		requestHeaders.set('sec-fetch-site', site);

		const response = await rewriter.bare.fetch(url.toString(), {
			method: serverRequest.method,
			redirect: 'manual',
			// redirect: serverRequest.redirect,
			body:
				(!BODY_ILLEGAL.includes(serverRequest.method) &&
					(await serverRequest.blob())) ||
				undefined,
			headers: capitalizeHeaders(requestHeaders),
		});

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

		for (const [header, value] of response.rawHeaders) {
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
) {
	const rewriter: Rewriter = {
		get config() {
			return {
				directory: this.directory,
				codec: codecType(this.codec),
				frameAncestors: init.frameAncestors,
				...(init.openTab ? { openTab: true } : {}),
				build: BUILD,
			};
		},
		cookies,
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
