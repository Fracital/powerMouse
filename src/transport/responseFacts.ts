// What a transport says of how an answer came, beyond its status, headers
// and body: the HTTP version it came over (our epoxy build and stomp-h3 say
// so in `httpVersion`). The BareCompatibleClient the worker fetches with
// makes a Response of the transport's answer and keeps none of it, but it
// keeps the answer's header list as the Response's `rawHeaders`, the same
// array: the facts are noted by that array as the transport answers.

import type {
	ProxyTransport,
	TransferrableResponse,
} from '@mercuryworkshop/proxy-transports';

/** how an answer came */
export interface ResponseFacts {
	/** the protocol as Chrome names it in resource timing, or null when the transport does not say */
	protocol: string | null;
}

const noted = new WeakMap<object, ResponseFacts>();

/**
 * The protocol a response came over as Chrome names it (nextHopProtocol),
 * from a transport's `httpVersion` ("1.1", "2", "3"), or null for none
 */
export function chromeProtocol(version: unknown): string | null {
	if (typeof version !== 'string') return null;
	switch (
		version
			.trim()
			.toLowerCase()
			.replace(/^http\//, '')
	) {
		case '3':
		case 'h3':
			return 'h3';
		case '2':
		case '2.0':
		case 'h2':
			return 'h2';
		case '1.1':
			return 'http/1.1';
		case '1.0':
			return 'http/1.0';
		case '0.9':
			return 'http/0.9';
		default:
			return null;
	}
}

/** what the transport said of the answer whose header list is `rawHeaders` */
export function factsOf(rawHeaders: unknown): ResponseFacts | undefined {
	return typeof rawHeaders === 'object' && rawHeaders !== null
		? noted.get(rawHeaders)
		: undefined;
}

/** note what the transport says of `response` */
export function noteFacts(response: TransferrableResponse) {
	const headers = (response as { headers?: unknown }).headers;
	if (typeof headers !== 'object' || headers === null) return;
	noted.set(headers, {
		protocol: chromeProtocol(
			(response as { httpVersion?: unknown }).httpVersion,
		),
	});
}

/**
 * `transport` as it is, but that what each of its answers says of itself is
 * noted (factsOf). Its own methods run on it, not on the wrapper: a class
 * with private fields refuses a `this` that is not itself.
 */
export function notingFacts(transport: ProxyTransport): ProxyTransport {
	const request: ProxyTransport['request'] = async (...args) => {
		const response = await transport.request(...args);
		noteFacts(response);
		return response;
	};
	return new Proxy(transport, {
		get(target, key) {
			if (key === 'request') return request;
			const value = Reflect.get(target, key, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
		set(target, key, value) {
			return Reflect.set(target, key, value, target);
		},
	});
}
