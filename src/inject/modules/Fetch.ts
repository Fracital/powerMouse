import {
	ROUTE_PROTOCOLS,
	routeBinary,
	routeRefused,
	routeXHR,
} from '../../routeURL';
import StompURL, { urlLike } from '../../StompURL';
import {
	ABORT_HEADER,
	BYTES_MARKER,
	CORS_MARKER,
	OPAQUE_COPY_HEADER,
	OPAQUE_HEADER,
	OPAQUE_MARKER,
	PROXY_METRICS,
	RESPONSE_TYPE_HEADER,
	siteMetrics,
	TIMING_ONLY_MARKER,
} from '../../transport/messages';
import Client from '../Client';
import Module from '../Module';
import { failsToParse, withStack } from '../nativeErrors';
import { LazyWeakMap, LazyWeakSet } from '../ownCollections';
import { requestRefused } from '../requestVerdict';
import ProxyModule, {
	catchRequiredArguments,
	memberName,
	ownerOf,
} from './Proxy';
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
const NativeProxy = Proxy;
const nativeHeadersForEach = Headers.prototype.forEach;
const nativeHeadersSet = Headers.prototype.set;
const nativeHeadersDelete = Headers.prototype.delete;
const nativeRequestHeaders = Reflect.getOwnPropertyDescriptor(
	Request.prototype,
	'headers',
)!.get!;
const nativeRequestReferrer = Reflect.getOwnPropertyDescriptor(
	Request.prototype,
	'referrer',
)!.get!;
/**
 * Whether `value` is a Request of any realm, as the browser tells: its own
 * getters check the object's brand, which a Request another window made
 * (an iframe's, the parent's) passes where `instanceof` sees another realm's
 * prototype. fetch and Request take such a request as the request it is,
 * never as the string "[object Request]"
 */
function isRequest(value: unknown): value is Request {
	if (typeof value !== 'object' || value === null) return false;
	try {
		Reflect.apply(nativeRequestReferrer, value, []);
		return true;
	} catch (error) {
		return false;
	}
}

const nativeHeadersGet = Headers.prototype.get;
const nativeResponseHeaders = Reflect.getOwnPropertyDescriptor(
	Response.prototype,
	'headers',
)!.get!;
const nativeResponseBody = Reflect.getOwnPropertyDescriptor(
	Response.prototype,
	'body',
)!.get!;

/**
 * The type a response the page holds has natively: every route is
 * same-origin to the browser, so its own says `basic` for all. Another
 * origin's is `cors`, or `opaque` for a no-cors request, which reads as the
 * browser's opaque response does. A response the inject makes for one the
 * browser would have had from the network (an emulated worker's navigation
 * preload) is `basic`. Kept for every realm of the bundle (a service
 * worker's answer, a response out of the Cache API)
 */
const responseTypes = new LazyWeakMap<Response, 'basic' | 'cors' | 'opaque'>();
/** the page's URL of a response, where the browser has the route */
const responseURLs = new LazyWeakMap<Response, string>();
const nativeUnescape = unescape;

/**
 * The header values the worker noted the bytes of (BYTES_MARKER), as
 * name, bytes, name, bytes; empty for none
 */
function sentBytes(timing: string | null): string[] {
	const bytes: string[] = [];
	const lead = `${BYTES_MARKER};desc="`;
	const at = timing === null ? -1 : timing.lastIndexOf(lead);
	if (at === -1) return bytes;
	const from = at + lead.length;
	const note = timing!.slice(from, timing!.indexOf('"', from));
	for (const pair of note.split(' ')) {
		const colon = pair.indexOf(':');
		bytes.push(pair.slice(0, colon), nativeUnescape(pair.slice(colon + 1)));
	}
	return bytes;
}

/** responses that came with RESPONSE_TYPE_HEADER, which the page never sees */
const marked = new LazyWeakSet<Response>();

/** the names of a Server-Timing value's metrics */
const metricNames = (value: string) =>
	value.split(',').map((metric) => metric.split(';')[0].trim());

/**
 * A Server-Timing value without the worker's metrics (PROXY_METRICS), as
 * the site sent it (siteMetrics), or null for none left or for a header the
 * page may not read at all (TIMING_ONLY_MARKER)
 */
export function withoutProxyMetrics(value: string): string | null {
	const names = metricNames(value);
	if (names.includes(TIMING_ONLY_MARKER)) return null;
	const kept = value
		.split(',')
		.filter((metric, index) => !PROXY_METRICS.includes(names[index]));
	return kept.length ? siteMetrics(kept.join(',').trim()) : null;
}

/** a response's body stream as the browser has it, whatever its type reads as */
export const nativeBodyOf = (response: Response) =>
	Reflect.apply(nativeResponseBody, response, []) as ReadableStream | null;

/** the type a response reads as to the page */
export const recordedType = (response: Response) => responseTypes.get(response);

/** the page's URL a response reads as, when it is not the browser's */
export const recordedURL = (response: Response) => responseURLs.get(response);

/** record what a response reads as to the page */
export function recordResponse(
	response: Response,
	type: 'basic' | 'cors' | 'opaque' | undefined,
	url?: string,
) {
	if (type !== undefined) responseTypes.set(response, type);
	if (url !== undefined) responseURLs.set(response, url);
}

/**
 * A response that says what it is (RESPONSE_TYPE_HEADER: an emulated
 * service worker's answer, one the Cache API kept) is recorded so, the
 * header hidden from the page; false for any other
 */
export function adoptTypeMark(response: Response): boolean {
	let headers: Headers;
	try {
		headers = Reflect.apply(nativeResponseHeaders, response, []) as Headers;
	} catch (error) {
		// not a Response (a worker's synchronous XMLHttpRequest makes its own)
		return false;
	}
	// the worker's Server-Timing metrics (resource timing's marks) are the
	// proxy's: the page reads the response's headers without them, and a
	// site's own metric named like one as the site named it
	const timing = Reflect.apply(nativeHeadersGet, headers, ['server-timing']) as
		string | null;
	if (timing?.includes('stomp-')) marked.add(response);
	const mark = Reflect.apply(nativeHeadersGet, headers, [
		RESPONSE_TYPE_HEADER,
	]) as string | null;
	if (mark === null) return false;
	const space = mark.indexOf(' ');
	const type = space === -1 ? mark : mark.slice(0, space);
	const url = space === -1 ? '' : mark.slice(space + 1);
	marked.add(response);
	recordResponse(
		response,
		type === 'cors' || type === 'opaque' ? type : 'basic',
		url || undefined,
	);
	return true;
}

/**
 * Whether the worker answered a copy the inject asked for (a granted
 * request) as one the page may not read: another origin's no-cors load
 * (OPAQUE_COPY_HEADER)
 */
export function opaqueCopy(response: Response): boolean {
	try {
		const headers = Reflect.apply(nativeResponseHeaders, response, []);
		return (
			Reflect.apply(nativeHeadersGet, headers, [OPAQUE_COPY_HEADER]) ===
			'opaque'
		);
	} catch (error) {
		return false;
	}
}

/**
 * Whether the worker marked a response as another origin's data whatever its
 * URL (OPAQUE_MARKER: a no-cors chain that went through another origin)
 */
export function opaqueMarked(response: Response): boolean {
	return hasMark(response, OPAQUE_MARKER);
}

/** whether the worker's answer carries its Server-Timing mark `mark` */
function hasMark(response: Response, mark: string): boolean {
	try {
		const headers = Reflect.apply(nativeResponseHeaders, response, []);
		const timing = Reflect.apply(nativeHeadersGet, headers, [
			'server-timing',
		]) as string | null;
		return timing !== null && metricNames(timing).includes(mark);
	} catch (error) {
		return false;
	}
}

const nativeResponseStatus = Reflect.getOwnPropertyDescriptor(
	Response.prototype,
	'status',
)!.get!;
const nativeResponseStatusText = Reflect.getOwnPropertyDescriptor(
	Response.prototype,
	'statusText',
)!.get!;

/**
 * A response the Cache API is given, as it must keep it: one whose type is
 * recorded (`cors` or `opaque` where the browser has a `basic` one, `basic`
 * where it has a `default` one) is kept with the mark of what it is (RESPONSE_TYPE_HEADER), which a match reads back
 * (adoptTypeMark). Any other goes as it is
 */
export function cacheableResponse(response: unknown): unknown {
	if (!(response instanceof Response)) return response;
	const type = responseTypes.get(response);
	if (type === undefined) return response;
	const headers = new Headers();
	for (const [name, value] of entriesOf(
		Reflect.apply(nativeResponseHeaders, response, []) as Headers,
	))
		if (name !== RESPONSE_TYPE_HEADER) headers.append(name, value);
	headers.set(
		RESPONSE_TYPE_HEADER,
		`${type} ${responseURLs.get(response) ?? ''}`,
	);
	return new Response(nativeBodyOf(response), {
		status: Reflect.apply(nativeResponseStatus, response, []) as number,
		statusText: Reflect.apply(nativeResponseStatusText, response, []) as string,
		headers,
	});
}

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
	// and the referrer the browser has (a route), which the prototype's
	// getter shows the page as its own URL
	Reflect.defineProperty(copy, 'referrer', {
		value: Reflect.apply(nativeRequestReferrer, copy, []),
		configurable: true,
	});
	return copy;
}

/** an id for a request the page may abort */
const abortId = () =>
	typeof crypto !== 'undefined' && 'randomUUID' in crypto
		? crypto.randomUUID()
		: `${Date.now()}-${Math.random()}`;

/**
 * Report a request of the page's for `url` that a report-only policy of
 * its connect-src refuses (src/csp.ts), `times` events as the browser fires
 * them: a document's client does (DocumentClient.reportRefusal)
 */
export function reportOnly(client: Client, url: URL, times: number) {
	(
		client as {
			reportRefusal?: (
				directive: string,
				url: URL,
				navigation: boolean,
				times: number,
			) => void;
		}
	).reportRefusal?.('connect-src', url, false, times);
}

export default class FetchModule extends Module<Client> {
	apply() {
		const client = this.client;
		const realm = client.global;
		const proxyModule = client.getModule(ProxyModule)!;

		const eventSourceURLs = new LazyWeakMap<EventSource, string>();

		realm.EventSource = proxyModule.wrapFunction(
			realm.EventSource,
			(target, that, args, newTarget) => {
				catchRequiredArguments(args.length, 1, 'EventSource', 'constructor');

				// a URL that does not parse: the browser's own SyntaxError, which
				// names the URL as the page wrote it
				const text = String(args[0]);
				if (failsToParse(client, text))
					return Reflect.construct(
						target,
						[text, ...args.slice(1)],
						newTarget || target,
					);
				const url = client.encodingParse(text, client.baseURL.toString());

				// one a worker's policy refuses fails as the browser fails it
				// (requestVerdict, which reports it with no sourceFile, as
				// Chrome reports an EventSource's). The page's init goes with
				// it: `withCredentials` is what makes the request one with
				// credentials (cookies to another origin)
				const resource = new StompURL(url, client.url);
				const result = Reflect.construct(
					target,
					[
						requestRefused(client, 'connect-src', url, 1, false)
							? routeRefused(resource, true)
							: routeBinary(resource),
						...args.slice(1),
					],
					newTarget || target,
				);

				eventSourceURLs.set(result, url.toString());
				reportOnly(client, url, 1);

				return result;
			},
			true,
		);

		Reflect.defineProperty(realm.EventSource.prototype, 'url', {
			configurable: true,
			enumerable: true,
			get: client
				.getModule(ProxyModule)!
				.wrapFunction(
					Reflect.getOwnPropertyDescriptor(realm.EventSource.prototype, 'url')!
						.get!,
					(target, that, args) => {
						if (eventSourceURLs.has(that)) {
							return eventSourceURLs.get(that);
						} else {
							return Reflect.apply(target, that, args);
						}
					},
				),
		});

		// A message of an EventSource names the origin of the stream's URL,
		// and every routed stream's is the proxy's: the page reads the real
		// one, in documents and workers alike. (After a redirect the browser
		// names the last URL's origin, which only the worker knows: this is
		// the first one's.) An event the page made itself and dispatched on
		// the source keeps what the page gave it.
		const messageOrigin = Reflect.getOwnPropertyDescriptor(
			realm.MessageEvent.prototype,
			'origin',
		);
		const nativeEventTarget = Reflect.getOwnPropertyDescriptor(
			realm.Event.prototype,
			'target',
		)?.get;
		if (messageOrigin?.get && nativeEventTarget)
			Reflect.defineProperty(realm.MessageEvent.prototype, 'origin', {
				...messageOrigin,
				get: proxyModule.wrapFunction(
					messageOrigin.get,
					(target, that: MessageEvent, args) => {
						const origin = Reflect.apply(target, that, args);
						if (!that.isTrusted) return origin;
						const url = eventSourceURLs.get(
							Reflect.apply(nativeEventTarget, that, []) as EventSource,
						);
						return url === undefined ? origin : new URL(url).origin;
					},
				),
			});

		const nativeResponseURL = Reflect.getOwnPropertyDescriptor(
			realm.Response.prototype,
			'url',
		)!.get!;
		Reflect.defineProperty(realm.Response.prototype, 'url', {
			configurable: true,
			enumerable: true,
			get: proxyModule.wrapFunction(nativeResponseURL, (target, that, args) => {
				if (responseURLs.has(that)) {
					return responseURLs.get(that);
				}
				// a response that came back from the Cache API or a clone the
				// page made: its URL is the routed one it was fetched from
				const url = Reflect.apply(<Function>target, that, args);
				return typeof url === 'string' ? (unrouteURL(client, url) ?? url) : url;
			}),
		});

		// over the URL's readback above
		this.hookResponses();

		// Response.redirect(url) resolves a relative URL against the page's
		// own, where the browser's base is the route (its Location header
		// would name the proxy)
		realm.Response.redirect = proxyModule.wrapFunction(
			realm.Response.redirect,
			(target, that, args) => {
				if (!args.length) return Reflect.apply(target, that, args);
				let location: string;
				try {
					location = new URL(String(args[0]), client.baseURL.toString()).href;
				} catch (error) {
					throw new realm.TypeError(
						"Failed to execute 'redirect' on 'Response': Invalid URL",
					);
				}
				return Reflect.apply(target, that, [location, ...args.slice(1)]);
			},
		);

		/**
		 * An init whose `referrer` the browser can take. The page names a URL
		 * of its own: one of its origin goes as its route (same-origin to the
		 * browser, and the worker reads the real one back), one of another
		 * origin is the client's default, as natively, where the browser would
		 * have taken a URL that happens to be of the proxy's origin. One that
		 * does not parse is the TypeError the browser throws (`failed` is how
		 * its message begins). The init is read through, not copied: it may
		 * be a Request, whose members are its prototype's getters.
		 */
		const pageReferrer = <T extends RequestInit | undefined>(
			init: T,
			failed: string,
		): T => {
			if (init === undefined || init === null || typeof init !== 'object')
				return init;
			const given = (init as RequestInit).referrer;
			if (given === undefined) return init;
			const referrer = String(given);
			if (referrer === '' || referrer === 'about:client') return init;
			let requested: URL;
			try {
				requested = new URL(referrer, client.baseURL.toString());
			} catch (error) {
				throw new realm.TypeError(
					`${failed}: Referrer '${referrer}' is not a valid URL.`,
				);
			}
			const taken =
				requested.origin === client.url.url.origin
					? routeXHR(new StompURL(requested, client.url))
					: 'about:client';
			return new NativeProxy(init as RequestInit & object, {
				get: (target, key) =>
					key === 'referrer' ? taken : Reflect.get(target, key, target),
			}) as T;
		};
		const fetchFailed = `Failed to execute 'fetch' on '${
			client.isWorker ? 'WorkerGlobalScope' : 'Window'
		}'`;

		realm.Request = proxyModule.wrapFunction(
			realm.Request,
			(target, _that, args, newTarget) => {
				if (args.length === 0) {
					throw withStack(
						new realm.DOMException(
							"Failed to construct 'Request': 1 argument required, but only 0 present.'",
						),
					);
				}

				// a Request given as the input is copied as it is (its URL was
				// resolved when it was made); anything else is a URL string to
				// resolve against the page's real URL, which String(Request) is not
				let input: Request | URL;
				if (isRequest(args[0])) input = args[0];
				else {
					const text = String(args[0]);
					try {
						input = new URL(text, client.baseURL.toString());
					} catch (error) {
						// a URL that does not parse against the page's (a relative
						// one in a data: worker, whose origin is opaque) throws
						// Request's own error, not URL's
						throw new realm.TypeError(
							`Failed to construct 'Request': Failed to parse URL from ${text}`,
						);
					}
				}
				return Reflect.construct(
					target,
					[input, pageReferrer(args[1], "Failed to construct 'Request'")],
					newTarget,
				);
			},
			true,
		);
		// (the fetch hook makes its own, whatever the page puts on the window)
		const PageRequest = realm.Request;

		// a Request's referrer is a route to the browser (pageReferrer): the
		// page reads the URL it gave
		const referrerDescriptor = Reflect.getOwnPropertyDescriptor(
			realm.Request.prototype,
			'referrer',
		)!;
		Reflect.defineProperty(realm.Request.prototype, 'referrer', {
			...referrerDescriptor,
			get: proxyModule.wrapFunction(
				referrerDescriptor.get!,
				(target, that, args) => {
					const referrer = Reflect.apply(target, that, args);
					if (
						typeof referrer !== 'string' ||
						referrer === '' ||
						referrer === 'about:client'
					)
						return referrer;
					return unrouteURL(client, referrer) ?? referrer;
				},
			),
		});

		// a Request's own URL: the browser fetches that, whatever `url` the
		// page has defined on the object (YouTube shadows a data: Request's
		// url and method to see whether fetch reads them)
		const nativeRequestURL = Reflect.getOwnPropertyDescriptor(
			realm.Request.prototype,
			'url',
		)!.get!;
		const nativeRequestMode = Reflect.getOwnPropertyDescriptor(
			realm.Request.prototype,
			'mode',
		)!.get!;

		const nativeResponseType = Reflect.getOwnPropertyDescriptor(
			realm.Response.prototype,
			'type',
		)!.get!;

		// (where the browser has it: the window itself, a worker scope's
		// prototype)
		ownerOf(realm, 'fetch').fetch = proxyModule.wrapFunction(
			realm.fetch,
			async (target, that, args) => {
				// nothing to fetch: the browser's own rejection
				if (!args.length) return await Reflect.apply(target, that, args);
				// called on something that is not this scope (fetch.call(o)):
				// the browser says whether it takes the receiver, asked with
				// no argument, which fetches nothing and rejects either way
				if (that !== undefined && that !== null && that !== realm) {
					const refusal = (await Reflect.apply(target, that, []).then(
						() => null,
						(error: unknown) => error,
					)) as Error | null;
					if (/Illegal invocation$/.test(String(refusal?.message)))
						return await Reflect.apply(target, that, args);
				}
				let init: RequestInit;
				let url: urlLike;

				let request = isRequest(args[0]) ? args[0] : null;
				// fetch(request, init) is a fetch of `new Request(request, init)`:
				// what the init names replaces the request's (its method, body,
				// headers, signal), which reading the request alone would drop
				if (request && args[1] !== undefined && args[1] !== null)
					request = new PageRequest(request, args[1]);
				if (request) {
					url = new URL(Reflect.apply(nativeRequestURL, request, []) as string);
					init = request;
				} else {
					// a URL that does not parse: the browser's own rejection, which
					// names the URL as the page wrote it
					const text = String(args[0]);
					if (args.length && failsToParse(client, text))
						return await Reflect.apply(target, that, [text, ...args.slice(1)]);
					url = new URL(text, client.baseURL.toString());
					// a URL with credentials is no request: the browser's own
					// TypeError, which the route (it has none) would not get
					if (url.username !== '' || url.password !== '')
						throw new realm.TypeError(
							`${fetchFailed}: Request cannot be constructed from a URL that includes credentials: ${url.href}`,
						);
					init = args[1];
				}
				// the request's mode, which decides the response's type
				const mode = request
					? (Reflect.apply(nativeRequestMode, request, []) as RequestMode)
					: ((args[1] as RequestInit | undefined)?.mode ?? 'cors');

				// one a worker's policy refuses (requestVerdict, which reports it
				// as the browser does: twice for a report-only policy alone) fails
				// as the browser fails it, with its own TypeError
				if (requestRefused(client, 'connect-src', url, 2))
					return await fetch(routeRefused(new StompURL(url, client.url)));
				if (!ROUTE_PROTOCOLS.includes(url.protocol)) {
					// a page-origin blob: URL is fetched as the browser's (another
					// site's, as no URL: src/inject/modules/ObjectURL.ts)
					const browserURL = routeXHR(new StompURL(url, client.url));
					// a Request of a URL the browser can fetch as it is goes as
					// itself: as an init its members would be read through the
					// getters the page may have put on it
					if (request && browserURL === url.href) return await fetch(request);
					return await fetch(browserURL, init);
				}
				// a report-only policy's refusal (an enforced one is the
				// worker's): a fetch is judged twice natively
				reportOnly(client, url, 2);

				// an explicit referrer is a page URL (a Request's was taken when
				// it was made)
				if (!request) init = pageReferrer(init, fetchFailed);
				// the proxy's own headers: an abort never reaches the worker on its
				// own, so the request carries an id and the abort is posted to the
				// worker under it; a request of an opaque origin goes as one
				const add: Record<string, string> = {};
				const signal = init?.signal;
				let aborted: string | null = null;
				if (signal) aborted = add[ABORT_HEADER] = abortId();
				if (client.opaqueRequests) add[OPAQUE_HEADER] = '1';
				// what goes out: the page's headers without the proxy's markers
				// (the worker trusts those), the proxy's own added
				init = isRequest(init)
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
					if (signal.aborted) client.abortRequest(id);
					else
						signal.addEventListener('abort', () => client.abortRequest(id), {
							once: true,
						});
				}
				// [input, init]
				//TODO: COOKIES
				// through a controlled realm (this one, or an ancestor when this
				// document is one no service worker controls)
				const res = await client.routedFetch(
					routeXHR(new StompURL(url, client.url)),
					init,
				);
				// the response may have set cookies: document.cookie reads fresh
				client.notifyResponse();

				// the page's URL for the routed one (unrouteURL reads the routed
				// prefix off the client, not this bundle's free `location`)
				const routedURL = Reflect.apply(nativeResponseURL, res, []) as string;
				const pageURL = unrouteURL(client, routedURL) ?? routedURL;
				responseURLs.set(res, pageURL);
				// an answer of the page's emulated service worker says its own
				// type and URL (a body it made is basic, whatever the URL)
				if (adoptTypeMark(res)) return res;

				// another origin's response, after any redirects, or one that
				// went through another origin (a redirect back is tainted too)
				const own = client.opaqueRequests ? 'null' : client.url.url.origin;
				let finalOrigin = 'null';
				try {
					finalOrigin = new URL(pageURL).origin;
				} catch (error) {
					// no URL: as another origin's
				}
				const type = Reflect.apply(nativeResponseType, res, []);
				if (type === 'basic' && (finalOrigin !== own || url.origin !== own))
					responseTypes.set(res, mode === 'no-cors' ? 'opaque' : 'cors');
				// a no-cors chain from this origin through another and back (A
				// to B to A): its URLs are this origin's, the worker marks it
				else if (type === 'basic' && mode === 'no-cors' && opaqueMarked(res))
					responseTypes.set(res, 'opaque');
				// and a cors one through another origin and back is a cors
				// response, as natively (the worker marks every cors answer of
				// a chain that left the origin: CORS_MARKER)
				else if (type === 'basic' && hasMark(res, CORS_MARKER))
					responseTypes.set(res, 'cors');

				return res;
			},
		);

		// fetchLater (a deferred fetch, sent when the document goes or once
		// `activateAfter` has passed): its request went to the address the page
		// named, past the proxy, to the real site, and Chrome hands no
		// deferred request to a service worker, so a routed one would reach
		// nothing. It is made here: the page's own fetch (keepalive, routed
		// like any) once the time has passed or as the document goes (pagehide,
		// as it is unloaded or put in the back/forward cache), unless its
		// signal aborted first. The page gets a FetchLaterResult whose
		// `activated` says whether it was sent.
		const global = realm as typeof globalThis & {
			fetchLater?: (...args: unknown[]) => unknown;
			FetchLaterResult?: { prototype: object };
		};
		const resultPrototype = global.FetchLaterResult?.prototype;
		const activatedGetter =
			resultPrototype &&
			Reflect.getOwnPropertyDescriptor(resultPrototype, 'activated')?.get;
		if (
			typeof global.fetchLater === 'function' &&
			resultPrototype &&
			activatedGetter
		) {
			const hookedFetch = global.fetch;
			// the browser's own, as the page may replace the window's later
			const nativeSetTimeout = global.setTimeout;
			const nativeAdd = global.EventTarget.prototype.addEventListener;
			const nativeRemove = global.EventTarget.prototype.removeEventListener;
			const failed = (message: string) =>
				`Failed to execute 'fetchLater' on 'Window': ${message}`;
			const deferred = new LazyWeakMap<object, { activated: boolean }>();
			Reflect.defineProperty(resultPrototype, 'activated', {
				...Reflect.getOwnPropertyDescriptor(resultPrototype, 'activated'),
				get: proxyModule.wrapFunction(activatedGetter, (target, that, args) => {
					const state = deferred.get(that as object);
					return state ? state.activated : Reflect.apply(target, that, args);
				}),
			});
			global.fetchLater = proxyModule.wrapFunction(
				global.fetchLater,
				(target, that, args) => {
					catchRequiredArguments(
						args.length,
						1,
						'Window',
						'fetchLater',
						global,
					);
					const request = isRequest(args[0]) ? args[0] : null;
					let url: URL;
					try {
						url = request
							? new URL(Reflect.apply(nativeRequestURL, request, []) as string)
							: new URL(String(args[0]), client.baseURL.toString());
					} catch (error) {
						// the browser's own TypeError for a URL that does not parse
						return Reflect.apply(target, that, args);
					}
					// (no http(s) URL: the browser's own refusal, which sends nothing)
					if (!ROUTE_PROTOCOLS.includes(url.protocol))
						return Reflect.apply(target, that, args);
					const { activateAfter, signal, ...init } = (args[1] ??
						{}) as RequestInit & { activateAfter?: number };
					// what the browser refuses before it defers anything
					if (activateAfter !== undefined && !(Number(activateAfter) >= 0))
						throw new global.RangeError(
							failed("fetchLater's activateAfter cannot be negative."),
						);
					if (signal?.aborted)
						throw withStack(
							new global.DOMException(
								failed('The user aborted a fetchLater request.'),
								'AbortError',
							),
						);
					if (init.body instanceof global.ReadableStream)
						throw new global.TypeError(
							failed("fetchLater doesn't support body with unknown length."),
						);
					const method = String(
						init.method ?? (request ? Reflect.get(request, 'method') : 'GET'),
					).toUpperCase();
					if (
						(method === 'GET' || method === 'HEAD') &&
						init.body !== undefined &&
						init.body !== null
					)
						throw new global.TypeError(
							failed('Request with GET/HEAD method cannot have body.'),
						);
					const state = { activated: false };
					const result = Object.create(resultPrototype) as object;
					deferred.set(result, state);
					const send = () => {
						if (state.activated || signal?.aborted) return;
						state.activated = true;
						Reflect.apply(nativeRemove, global, ['pagehide', send]);
						const sent = Reflect.apply(hookedFetch, global, [
							request ?? url.href,
							{ ...init, keepalive: true },
						]) as Promise<unknown>;
						// (what the site answers is no one's: fetchLater has no response)
						sent.catch(() => {});
					};
					Reflect.apply(nativeAdd, global, ['pagehide', send]);
					if (activateAfter !== undefined)
						Reflect.apply(nativeSetTimeout, global, [
							send,
							Number(activateAfter),
						]);
					return result;
				},
			);
		}
	}
	/**
	 * Responses read as their recorded type: `type` itself, and for an
	 * opaque one everything else the browser hides (status 0, no status
	 * text, URL, headers or body, not redirected). A clone keeps its type
	 */
	hookResponses() {
		const types = responseTypes;
		const proxyModule = this.client.getModule(ProxyModule)!;
		const global = this.client.global;
		const proto = global.Response.prototype;
		const emptyHeaders = new LazyWeakMap<Response, Headers>();
		const shownHeaders = new LazyWeakMap<Response, Headers>();
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
		// one getter call for the type and every opaque member, which reads
		// which it is from the native getter it wraps
		const responseGetter = (
			target: Function,
			that: unknown,
			args: unknown[],
		) => {
			const name = memberName(target);
			const type = types.get(that as Response);
			if (type !== undefined) {
				if (name === 'type') return type;
				if (type === 'opaque') return opaque[name](that as Response);
			}
			// the proxy's mark of what a response is: never the page's
			if (name === 'headers' && marked.has(that as Response)) {
				let shown = shownHeaders.get(that as Response);
				if (!shown) {
					shown = new global.Headers();
					const real = Reflect.apply(target, that, args) as Headers;
					// a value's bytes, which reached the browser encoded again
					const bytes = sentBytes(
						Reflect.apply(nativeHeadersGet, real, ['server-timing']),
					);
					for (const [key, value] of entriesOf(real)) {
						if (key === RESPONSE_TYPE_HEADER) continue;
						if (key === 'server-timing') {
							const page = withoutProxyMetrics(value);
							if (page !== null) shown.append(key, page);
							continue;
						}
						let i = 0;
						while (i < bytes.length && bytes[i] !== key) i += 2;
						shown.append(key, i < bytes.length ? bytes[i + 1] : value);
					}
					shownHeaders.set(that as Response, shown);
				}
				return shown;
			}
			return Reflect.apply(target, that, args);
		};
		for (const name of ['type', ...Object.keys(opaque)]) {
			const descriptor = Reflect.getOwnPropertyDescriptor(proto, name);
			if (!descriptor?.get) continue;
			Reflect.defineProperty(proto, name, {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get, responseGetter),
			});
		}
		proto.clone = proxyModule.wrapFunction(
			proto.clone,
			(target, that, args) => {
				const copy = Reflect.apply(target, that, args) as Response;
				const type = types.get(that as Response);
				if (type !== undefined) types.set(copy, type);
				const url = responseURLs.get(that as Response);
				if (url !== undefined) responseURLs.set(copy, url);
				if (marked.has(that as Response)) marked.add(copy);
				return copy;
			},
		) as Response['clone'];
		// nothing of an opaque response's body reaches the page, however it
		// asks (its bytes are there when an emulated service worker hands an
		// opaque answer on, which an image may show)
		const emptyBody: Record<string, () => unknown> = {
			text: () => global.Promise.resolve(''),
			arrayBuffer: () => global.Promise.resolve(new global.ArrayBuffer(0)),
			bytes: () => global.Promise.resolve(new global.Uint8Array(0)),
			blob: () => global.Promise.resolve(new global.Blob([])),
			json: () => global.Promise.resolve().then(() => global.JSON.parse('')),
			formData: () =>
				global.Promise.reject(
					new global.TypeError(
						"Failed to execute 'formData' on 'Response': Failed to fetch",
					),
				),
		};
		// (a text stream is the browser's own of an empty body: a stream
		// that ends at once, as natively for an opaque response)
		const EmptyResponse = global.Response;
		const textStream = (proto as unknown as Record<string, unknown>).textStream;
		if (typeof textStream === 'function')
			emptyBody.textStream = () =>
				Reflect.apply(textStream, new EmptyResponse(), []);
		const bodyMethod = (target: Function, that: unknown, args: unknown[]) =>
			types.get(that as Response) === 'opaque'
				? emptyBody[target.name]()
				: Reflect.apply(target, that, args);
		for (const name of Object.keys(emptyBody)) {
			const native = (proto as unknown as Record<string, unknown>)[name];
			if (typeof native !== 'function') continue;
			(proto as unknown as Record<string, unknown>)[name] =
				proxyModule.wrapFunction(native as Function, bodyMethod);
		}
	}
}
