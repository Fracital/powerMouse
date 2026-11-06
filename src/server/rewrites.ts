import {
	BareCompatibleClient,
	type ProxyTransport,
} from '@mercuryworkshop/proxy-transports';
import GenericCodec from '../Codecs';
import { codecType, Config, ParsedConfig } from '../config';
import { capitalizeHeaders, trimNonStandardHeaders } from '../headers';
import { modifyCSS, routeCSS } from '../rewriteCSS';
import { modifyHTML, modifyRefresh, routeHTML } from '../rewriteHTML';
import { modifyJS, routeJS, ScriptType } from '../rewriteJS';
import { parseRoutedURL, routeBinary } from '../routeURL';
import StompURL from '../StompURL';
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

		requestHeaders.set('sec-fetch-dest', serverRequest.destination);

		// Referer and Origin are forbidden headers, so the service worker never
		// sees them; rebuild them from the (proxied) referrer
		requestHeaders.delete('referer');
		requestHeaders.delete('origin');

		if (serverRequest.referrer && serverRequest.referrer !== 'about:client') {
			try {
				const referrer = parseRoutedURL(
					serverRequest.referrer,
					rewriter.codec,
					`${oURL.origin}${rewriter.directory}`,
				).url.url;

				requestHeaders.set('referer', referrer.toString());

				if (!BODY_ILLEGAL.includes(serverRequest.method))
					requestHeaders.set('origin', referrer.origin);
			} catch (error) {
				// referrer isn't a proxied URL (e.g. the controller page)
			}
		}

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
			(headers, filteredHeaders) => {
				trimNonStandardHeaders(filteredHeaders);
			},
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
				trimNonStandardHeaders(filteredHeaders);

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
				trimNonStandardHeaders(filteredHeaders);

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
			async (url, response, responseHeaders) =>
				htmlMimes.includes(
					getMime(responseHeaders.get('content-type') || ''),
				) && modifyHTML(await response.text(), url, rewriter.config),
			(resource, url) => routeHTML(resource, url, rewriter.config),
			undefined,
			(headers, filteredHeaders, url) => {
				trimNonStandardHeaders(filteredHeaders);

				if (headers.has('x-frame-options')) {
					filteredHeaders.delete('x-frame-options');
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
