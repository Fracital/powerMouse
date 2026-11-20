// What a transport says of how an answer came, beyond its status, headers
// and body: the HTTP version it came over (our epoxy build and stomp-h3 say
// so in `httpVersion`), when its connection's steps happened or that it
// reused one (`connection`), and how many bytes its body came as before the
// transport decoded its Content-Encoding (`encodedBytes`, a function read
// once the body has ended; bodyPort.ts carries its answer across threads
// at the body's end). The BareCompatibleClient the worker fetches with
// makes a Response of the transport's answer and keeps none of it, but it
// keeps the answer's header list as the Response's `rawHeaders`, the same
// array: the facts are noted by that array as the transport answers.

import type {
	ProxyTransport,
	TransferrableResponse,
} from '@mercuryworkshop/proxy-transports';

/**
 * When the steps of the connection a request went out on happened, in ms
 * after the transport was asked for it, with Chrome's meanings of what a
 * client over wisp can see: a lookup the request waited for (the HTTPS
 * record's), the wisp stream asked for, the TLS ClientHello written (the
 * QUIC Initial sent), the handshake done, the request's head written. A
 * connection that had carried a request before is `reused`, with only the
 * request's time.
 */
export interface ConnectionTimes {
	reused: boolean;
	dnsStart?: number;
	dnsEnd?: number;
	connectStart?: number;
	secureStart?: number;
	connectEnd?: number;
	requestStart?: number;
}

/** the steps of ConnectionTimes, in their order */
export const CONNECTION_STEPS = [
	'dnsStart',
	'dnsEnd',
	'connectStart',
	'secureStart',
	'connectEnd',
	'requestStart',
] as const;

/** how many bytes a body came as before its Content-Encoding was decoded, once it has ended */
export type EncodedBytes = () => number | undefined;

/** how an answer came */
export interface ResponseFacts {
	/** the protocol as Chrome names it in resource timing, or null when the transport does not say */
	protocol: string | null;
	/** its connection's times, or null when the transport does not say */
	connection: ConnectionTimes | null;
	/** its body's bytes before decoding, or null when the transport does not count them */
	encodedBytes: EncodedBytes | null;
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

/** a transport's `connection`, checked; null when it is not one */
export function connectionTimes(value: unknown): ConnectionTimes | null {
	if (typeof value !== 'object' || value === null) return null;
	const given = value as Record<string, unknown>;
	if (typeof given.reused !== 'boolean') return null;
	const times: ConnectionTimes = { reused: given.reused };
	for (const step of CONNECTION_STEPS) {
		const time = given[step];
		if (typeof time === 'number' && Number.isFinite(time) && time >= 0)
			times[step] = time;
	}
	return times;
}

/** `times` moved `by` ms later (the time from the request's arrival to the transport's call) */
export function laterConnection(
	times: ConnectionTimes,
	by: number,
): ConnectionTimes {
	const later: ConnectionTimes = { reused: times.reused };
	for (const step of CONNECTION_STEPS)
		if (times[step] !== undefined) later[step] = times[step] + by;
	return later;
}

/** a transport answer's `encodedBytes`, or null when it has none */
export function encodedBytesOf(response: object): EncodedBytes | null {
	const counted = (response as { encodedBytes?: unknown }).encodedBytes;
	return typeof counted === 'function' ? (counted as EncodedBytes) : null;
}

/**
 * `response` without its `encodedBytes` (a function, which no structured
 * clone carries), and that function
 */
export function withoutEncodedBytes<T extends object>(
	response: T,
): [Omit<T, 'encodedBytes'>, EncodedBytes | null] {
	const counted = encodedBytesOf(response);
	if (!counted) return [response, null];
	const rest = { ...response } as T & { encodedBytes?: unknown };
	delete rest.encodedBytes;
	return [rest, counted];
}

/**
 * A copy of `response` with `changes`, keeping its `encodedBytes`: our
 * epoxy build makes it not enumerable, so that a host posting the answer on
 * as it is drops it instead of failing the clone, and a spread drops it too
 */
export function changedResponse<T extends object>(
	response: T,
	changes: Partial<T>,
): T {
	const changed = { ...response, ...changes };
	const counted = encodedBytesOf(response);
	if (counted && !Object.prototype.hasOwnProperty.call(changes, 'encodedBytes'))
		Object.defineProperty(changed, 'encodedBytes', {
			value: counted,
			enumerable: false,
			configurable: true,
			writable: true,
		});
	return changed;
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
		connection: connectionTimes(
			(response as { connection?: unknown }).connection,
		),
		encodedBytes: encodedBytesOf(response),
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

// (a token, which needs no quotes and holds no comma, for whatever reads
// the header as a list: Fetch.ts takes the marks out of it)
/** a 0.1 ms figure, or x for a step not seen */
const figure = (time: number | undefined) =>
	time === undefined ? 'x' : String(Math.round(time * 10) / 10);

/** the description of CONNECTION_MARKER (messages.ts) for `times` */
export function connectionMark(times: ConnectionTimes): string {
	return times.reused
		? `r_${figure(times.requestStart)}`
		: CONNECTION_STEPS.map((step) => figure(times[step])).join('_');
}

/** CONNECTION_MARKER's description read back; null when it is not one */
export function readConnectionMark(text: string): ConnectionTimes | null {
	const parts = text.split('_');
	const time = (part: string | undefined) =>
		part !== undefined && /^\d+(\.\d+)?$/.test(part) ? Number(part) : undefined;
	if (parts[0] === 'r') {
		if (parts.length !== 2) return null;
		const requestStart = time(parts[1]);
		return requestStart === undefined
			? { reused: true }
			: { reused: true, requestStart };
	}
	if (parts.length !== CONNECTION_STEPS.length) return null;
	const times: ConnectionTimes = { reused: false };
	CONNECTION_STEPS.forEach((step, index) => {
		const value = time(parts[index]);
		if (value !== undefined) times[step] = value;
	});
	return times;
}
