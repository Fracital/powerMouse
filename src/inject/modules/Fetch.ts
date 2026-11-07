import {
	parseRoutedURL,
	ROUTE_PROTOCOLS,
	routeBinary,
	routeXHR,
} from '../../routeURL';
import StompURL, { urlLike } from '../../StompURL';
import { ABORT_HEADER } from '../../transport/messages';
import Client from '../Client';
import Module from '../Module';
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

				return Reflect.construct(
					target,
					[new URL(args[0], this.client.url.toString()), args[1]],
					newTarget,
				);
			},
			true,
		);

		this.client.global.fetch = proxyModule.wrapFunction(
			this.client.global.fetch,
			async (_target, _that, args) => {
				let init: RequestInit;
				let url: urlLike;

				if (args[0] instanceof Request) {
					url = new URL(args[0].url);
					init = args[0];
				} else {
					url = new URL(args[0], this.client.url.toString());
					init = args[1];
				}

				if (!ROUTE_PROTOCOLS.includes(url.protocol)) {
					return await fetch(url, init);
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
				const res = await fetch(
					routeXHR(new StompURL(url, this.client.url)),
					init,
				);
				// the response may have set cookies: document.cookie reads fresh
				this.client.notifyResponse();

				responseURLs.set(
					res,
					parseRoutedURL(
						Reflect.apply(nativeResponseURL, res, []) as string,
						this.client.codec,
						`${location.origin}${this.client.directory}`,
					).url.toString(),
				);

				return res;
			},
		);
	}
}
