import {
	proxyBlobURL,
	ROUTE_PROTOCOLS,
	routeBinary,
	routeXHR,
} from '../../routeURL';
import StompURL, { urlLike } from '../../StompURL';
import { ABORT_HEADER } from '../../transport/messages';
import Client from '../Client';
import Module from '../Module';
import { failsToParse } from '../nativeErrors';
import ProxyModule, { catchRequiredArguments } from './Proxy';
import { unrouteURL } from './Unroute';

/** an id for a request the page may abort */
const abortId = () =>
	typeof crypto !== 'undefined' && 'randomUUID' in crypto
		? crypto.randomUUID()
		: `${Date.now()}-${Math.random()}`;

export default class FetchModule extends Module<Client> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;

		const eventSourceURLs = new WeakMap<EventSource, string>();
		const responseURLs = new WeakMap<Response, string>();

		this.client.global.EventSource = proxyModule.wrapFunction(
			this.client.global.EventSource,
			(target, that, args, newTarget) => {
				catchRequiredArguments(args.length, 1, 'EventSource', 'constructor');

				const url = new URL(args[0], this.client.url.toString());

				const result = Reflect.construct(
					target,
					[routeBinary(new StompURL(url, this.client.url))],
					newTarget || target,
				);

				eventSourceURLs.set(result, url.toString());

				return result;
			},
			true,
		);

		Reflect.defineProperty(this.client.global.EventSource.prototype, 'url', {
			configurable: true,
			enumerable: true,
			get: this.client
				.getModule(ProxyModule)!
				.wrapFunction(
					Reflect.getOwnPropertyDescriptor(
						this.client.global.EventSource.prototype,
						'url',
					)!.get!,
					(target, that, args) => {
						if (eventSourceURLs.has(that)) {
							return eventSourceURLs.get(that);
						} else {
							return Reflect.apply(target, that, args);
						}
					},
				),
		});

		const nativeResponseURL = Reflect.getOwnPropertyDescriptor(
			this.client.global.Response.prototype,
			'url',
		)!.get!;
		Reflect.defineProperty(this.client.global.Response.prototype, 'url', {
			configurable: true,
			enumerable: true,
			get: proxyModule.wrapFunction(nativeResponseURL, (target, that, args) => {
				if (responseURLs.has(that)) {
					return responseURLs.get(that);
				}
				// a response that came back from the Cache API or a clone the
				// page made: its URL is the routed one it was fetched from
				const url = Reflect.apply(<Function>target, that, args);
				return typeof url === 'string'
					? (unrouteURL(this.client, url) ?? url)
					: url;
			}),
		});

		this.client.global.Request = proxyModule.wrapFunction(
			this.client.global.Request,
			(target, _that, args, newTarget) => {
				if (args.length === 0) {
					throw new this.client.global.DOMException(
						"Failed to construct 'Request': 1 argument required, but only 0 present.'",
					);
				}

				// a Request given as the input is copied as it is (its URL was
				// resolved when it was made); anything else is a URL string to
				// resolve against the page's real URL, which String(Request) is not
				let input: Request | URL;
				if (args[0] instanceof target) input = args[0];
				else {
					const text = String(args[0]);
					try {
						input = new URL(text, this.client.url.toString());
					} catch (error) {
						// a URL that does not parse against the page's (a relative
						// one in a data: worker, whose origin is opaque) throws
						// Request's own error, not URL's
						throw new this.client.global.TypeError(
							`Failed to construct 'Request': Failed to parse URL from ${text}`,
						);
					}
				}
				return Reflect.construct(target, [input, args[1]], newTarget);
			},
			true,
		);

		// a Request's own URL: the browser fetches that, whatever `url` the
		// page has defined on the object (YouTube shadows a data: Request's
		// url and method to see whether fetch reads them)
		const nativeRequestURL = Reflect.getOwnPropertyDescriptor(
			this.client.global.Request.prototype,
			'url',
		)!.get!;

		this.client.global.fetch = proxyModule.wrapFunction(
			this.client.global.fetch,
			async (target, that, args) => {
				let init: RequestInit;
				let url: urlLike;

				const request = args[0] instanceof Request ? args[0] : null;
				if (request) {
					url = new URL(Reflect.apply(nativeRequestURL, request, []) as string);
					init = request;
				} else {
					// a URL that does not parse: the browser's own rejection, which
					// names the URL as the page wrote it
					const text = String(args[0]);
					if (args.length && failsToParse(this.client, text))
						return await Reflect.apply(target, that, [text, ...args.slice(1)]);
					url = new URL(text, this.client.url.toString());
					init = args[1];
				}

				if (!ROUTE_PROTOCOLS.includes(url.protocol)) {
					// a page-origin blob: URL is fetched as the browser's
					const browserURL = proxyBlobURL(url.href);
					// a Request of a URL the browser can fetch as it is goes as
					// itself: as an init its members would be read through the
					// getters the page may have put on it
					if (request && browserURL === url.href)
						return await fetch(request, args[1]);
					return await fetch(browserURL, init);
				}

				// an explicit referrer is a page URL: in proxy space (routed) the
				// browser takes it as same-origin and the worker reads the real
				// one back; one of another real origin is not allowed, and the
				// request falls back to its default, as the browser's would
				if (
					init &&
					!(init instanceof Request) &&
					typeof init.referrer === 'string' &&
					init.referrer !== '' &&
					init.referrer !== 'about:client'
				) {
					const { referrer, ...rest } = init;
					try {
						const requested = new URL(referrer, this.client.url.toString());
						init =
							requested.origin === this.client.url.url.origin
								? {
										...rest,
										referrer: routeXHR(
											new StompURL(requested, this.client.url),
										),
									}
								: rest;
					} catch (error) {
						init = rest;
					}
				}
				// an abort never reaches the worker on its own: the request carries
				// an id and the abort is posted to the worker under it
				const signal = init?.signal;
				if (signal) {
					const id = abortId();
					const headers = new Headers(init.headers ?? undefined);
					headers.set(ABORT_HEADER, id);
					init =
						init instanceof Request
							? new Request(init, { headers })
							: { ...init, headers };
					if (signal.aborted) this.client.abortRequest(id);
					else
						signal.addEventListener(
							'abort',
							() => this.client.abortRequest(id),
							{
								once: true,
							},
						);
				}
				// [input, init]
				//TODO: COOKIES
				// through a controlled realm (this one, or an ancestor when this
				// document is one no service worker controls)
				const res = await this.client.routedFetch(
					routeXHR(new StompURL(url, this.client.url)),
					init,
				);
				// the response may have set cookies: document.cookie reads fresh
				this.client.notifyResponse();

				// the page's URL for the routed one (unrouteURL reads the routed
				// prefix off the client, not this bundle's free `location`)
				const routedURL = Reflect.apply(nativeResponseURL, res, []) as string;
				responseURLs.set(res, unrouteURL(this.client, routedURL) ?? routedURL);

				return res;
			},
		);
	}
}
