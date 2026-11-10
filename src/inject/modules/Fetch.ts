import {
	proxyBlobURL,
	ROUTE_PROTOCOLS,
	routeBinary,
	routeXHR,
} from '../../routeURL';
import StompURL, { urlLike } from '../../StompURL';
import { ABORT_HEADER, OPAQUE_HEADER } from '../../transport/messages';
import Client from '../Client';
import Module from '../Module';
import { failsToParse } from '../nativeErrors';
import ProxyModule, { catchRequiredArguments } from './Proxy';
import { unrouteURL } from './Unroute';

/**
 * Whether a request header name is one of the proxy's markers (x-stomp-*):
 * the worker trusts those to come from the inject (a copy of a page's load
 * is exempt from CORS as the load it stands for), so a page's own request
 * never carries one
 */
export const isStompHeader = (name: string) =>
	name.length > 8 && name.slice(0, 8).toLowerCase() === 'x-stomp-';

// The browser's own Headers and Request members, taken when the bundle runs
// (before any page code): a page can replace the prototypes' iterators,
// getters and methods, and the browser reads a request's headers through
// them when it converts an init (`init.headers`, a Request's `headers`
// getter, a Headers' @@iterator)
const nativeHeadersForEach = Headers.prototype.forEach;
const nativeHeadersSet = Headers.prototype.set;
const nativeHeadersDelete = Headers.prototype.delete;
const nativeRequestHeaders = Reflect.getOwnPropertyDescriptor(
	Request.prototype,
	'headers',
)!.get!;

/** the names and values of a real Headers, read by the browser's own method */
function entriesOf(headers: Headers): [string, string][] {
	const entries: [string, string][] = [];
	Reflect.apply(nativeHeadersForEach, headers, [
		(value: string, name: string) => entries.push([name, value]),
	]);
	return entries;
}

/**
 * A request's headers as the page made them, without the proxy's markers,
 * as a record with no prototype: the browser converts a record by its own
 * properties, so nothing the page replaced adds a header to it
 */
export function pageHeaderRecord(
	headers: Headers,
	add: Record<string, string> = {},
): Record<string, string> {
	const record = Object.create(null) as Record<string, string>;
	for (const [name, value] of entriesOf(headers))
		if (!isStompHeader(name)) record[name] = value;
	for (const name of Object.keys(add)) record[name] = add[name];
	return record;
}

/**
 * A copy of a page's Request whose headers are the page's without the
 * proxy's markers, plus `add`: inside (where a Request made from it reads
 * them) and as its own `headers` (where an init dictionary is read, past
 * the prototype's getter the page may have replaced)
 */
export function pageRequest(
	request: Request,
	add: Record<string, string> = {},
): Request {
	const copy = new Request(request);
	const inside = Reflect.apply(nativeRequestHeaders, copy, []) as Headers;
	for (const [name] of entriesOf(inside))
		if (isStompHeader(name)) Reflect.apply(nativeHeadersDelete, inside, [name]);
	for (const name of Object.keys(add))
		Reflect.apply(nativeHeadersSet, inside, [name, add[name]]);
	Reflect.defineProperty(copy, 'headers', {
		value: pageHeaderRecord(inside),
		configurable: true,
	});
	return copy;
}

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
		/**
		 * The type a response of the page's fetch has natively: every route
		 * is same-origin to the browser, so its own says `basic` for all.
		 * Another origin's is `cors`, or `opaque` for a no-cors request, which
		 * the worker sent with nothing of the response (status, headers,
		 * body), and which reads as the browser's opaque response does
		 */
		const responseTypes = new WeakMap<Response, 'cors' | 'opaque'>();

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

		// over the URL's readback above
		this.hookResponses(responseTypes);

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
		const nativeRequestMode = Reflect.getOwnPropertyDescriptor(
			this.client.global.Request.prototype,
			'mode',
		)!.get!;

		const nativeResponseType = Reflect.getOwnPropertyDescriptor(
			this.client.global.Response.prototype,
			'type',
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
				// the request's mode, which decides the response's type
				const mode =
					(args[1] as RequestInit | undefined)?.mode ??
					(request
						? (Reflect.apply(nativeRequestMode, request, []) as RequestMode)
						: 'cors');

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
				// the proxy's own headers: an abort never reaches the worker on its
				// own, so the request carries an id and the abort is posted to the
				// worker under it; a request of an opaque origin goes as one
				const add: Record<string, string> = {};
				const signal = init?.signal;
				let aborted: string | null = null;
				if (signal) aborted = add[ABORT_HEADER] = abortId();
				if (this.client.opaqueRequests) add[OPAQUE_HEADER] = '1';
				// what goes out: the page's headers without the proxy's markers
				// (the worker trusts those), the proxy's own added
				init =
					init instanceof Request
						? pageRequest(init, add)
						: {
								...init,
								headers: pageHeaderRecord(
									new Headers(init?.headers ?? undefined),
									add,
								),
							};
				if (signal && aborted !== null) {
					const id = aborted;
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
				const pageURL = unrouteURL(this.client, routedURL) ?? routedURL;
				responseURLs.set(res, pageURL);

				// another origin's response, after any redirects, or one that
				// went through another origin (a redirect back is tainted too)
				const own = this.client.opaqueRequests
					? 'null'
					: this.client.url.url.origin;
				let finalOrigin = 'null';
				try {
					finalOrigin = new URL(pageURL).origin;
				} catch (error) {
					// no URL: as another origin's
				}
				const type = Reflect.apply(nativeResponseType, res, []);
				if (type === 'basic' && (finalOrigin !== own || url.origin !== own))
					responseTypes.set(res, mode === 'no-cors' ? 'opaque' : 'cors');

				return res;
			},
		);
	}
	/**
	 * Responses read as their recorded type: `type` itself, and for an
	 * opaque one everything else the browser hides (status 0, no status
	 * text, URL, headers or body, not redirected). A clone keeps its type
	 */
	hookResponses(types: WeakMap<Response, 'cors' | 'opaque'>) {
		const proxyModule = this.client.getModule(ProxyModule)!;
		const global = this.client.global;
		const proto = global.Response.prototype;
		const emptyHeaders = new WeakMap<Response, Headers>();
		const opaque: Record<string, (that: Response) => unknown> = {
			status: () => 0,
			ok: () => false,
			statusText: () => '',
			url: () => '',
			redirected: () => false,
			body: () => null,
			headers: (that) => {
				let headers = emptyHeaders.get(that);
				if (!headers) {
					headers = new global.Headers();
					emptyHeaders.set(that, headers);
				}
				return headers;
			},
		};
		for (const name of ['type', ...Object.keys(opaque)]) {
			const descriptor = Reflect.getOwnPropertyDescriptor(proto, name);
			if (!descriptor?.get) continue;
			Reflect.defineProperty(proto, name, {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get, (target, that, args) => {
					const type = types.get(that as Response);
					if (type !== undefined) {
						if (name === 'type') return type;
						if (type === 'opaque') return opaque[name](that as Response);
					}
					return Reflect.apply(target, that, args);
				}),
			});
		}
		proto.clone = proxyModule.wrapFunction(
			proto.clone,
			(target, that, args) => {
				const copy = Reflect.apply(target, that, args) as Response;
				const type = types.get(that as Response);
				if (type !== undefined) types.set(copy, type);
				return copy;
			},
		) as Response['clone'];
	}
}
