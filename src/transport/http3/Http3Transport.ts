// HTTP/3 the way Chrome uses it, over a transport that cannot do it itself.
// The base transport (epoxy) keeps serving HTTP/1.1 and HTTP/2 and every
// WebSocket; this wrapper learns which origins offer h3 (Alt-Svc, an HTTPS
// DNS record, or `force`), opens a QUIC connection to such an origin in the
// background over a wisp UDP stream (stomp-h3, quinn + h3 in wasm), and
// sends that origin's requests over it once it is up. A request never waits
// on QUIC that has not worked yet: until the handshake is done it goes over
// the base transport, so a wisp server or network that drops UDP costs
// nothing the user sees, and the failure marks the origin broken for a
// while (AltSvcCache). A UDP stream the wisp server refuses is a failure of
// that one origin; HTTP/3 goes off for every origin only on evidence about
// the relay itself (Relay, below). docs/http3.md has the design and its
// limits.
import type {
	ProxyTransport,
	RawHeaders,
	TransferrableResponse,
} from '@mercuryworkshop/proxy-transports';
import { pastASCII, utf8Bytes } from '../../byteString';
import { NETWORK_PARTITION } from '../networkPartition';
import { wispGone } from '../RevivingTransport';
import { logTransport, rideOf, transportLog } from '../transportLog';
import { AltSvcCache, type AltService } from './altSvc';
import { base64url, httpsQuery, parseHttpsAnswer } from './dnsHttps';
import { remoteH3Module } from './h3Thread';

/** a datagram channel bound to one remote: one Uint8Array per datagram each way */
export interface DatagramChannel {
	read: ReadableStream<Uint8Array>;
	write: WritableStream<Uint8Array>;
	/**
	 * The wisp close reason the stream ended with, once `read` has ended
	 * (epoxy builds with deploy/epoxy's patch 0058; older ones have no such
	 * method and the reason is not known)
	 */
	closeReason?: () => number | undefined;
}
export type UdpOpener = (
	host: string,
	port: number,
) => Promise<DatagramChannel>;

/** `TransportDescriptor.http3`; everything optional */
export interface Http3Options {
	/** URL of stomp-h3's `stomp_h3.js` (default: `h3/stomp_h3.js` next to the transport module) */
	module?: string;
	/** origins (`https://host[:port]`, or `host:port`) to use h3 on without an Alt-Svc first, like Chrome's `--origin-to-force-quic-on` */
	force?: string[];
	/** a DNS-over-HTTPS endpoint (RFC 8484, e.g. `https://cloudflare-dns.com/dns-query`) asked for HTTPS records; off when unset */
	dns?: string;
	/** extra trusted root certificates (PEM) for QUIC; tests */
	pem?: string;
	/** ms a QUIC handshake may take before the origin is marked broken (10000) */
	timeout?: number;
	/** ms a request waits for a reconnect to an origin QUIC already worked for (300) */
	wait?: number;
	/** instance hosts only (a function cannot cross into a worker): how to open a UDP channel when the base transport has no `client.connect_udp` */
	udp?: UdpOpener;
}

export interface H3Response {
	status: number;
	headers: RawHeaders;
	body: ReadableStream<Uint8Array> | null;
}
export interface H3Connection {
	readonly alive: boolean;
	readonly handshake_ms: number;
	stats(): Record<string, number>;
	close(): void;
	request(
		method: string,
		url: string,
		headers: RawHeaders,
		body: Uint8Array | ReadableStream<Uint8Array> | null,
	): Promise<H3Response>;
}
export interface H3Module {
	default(): Promise<unknown>;
	connect(
		host: string,
		readable: ReadableStream<Uint8Array>,
		writable: WritableStream<Uint8Array>,
		options: { pem?: string; timeoutMs?: number },
	): Promise<H3Connection>;
}

/** what `info()` reports */
export interface Http3Info {
	enabled: boolean;
	moduleError: string | null;
	/** HTTP/3 is off for every origin until then: the wisp relay is taken to have no UDP */
	udpBlockedUntil: number | null;
	/** a datagram came back over this wisp connection, so its relay has UDP */
	udpCarried: boolean;
	/** hosts the relay refused a UDP stream to while nothing had been carried */
	udpRefused: string[];
	altSvc: {
		origin: string;
		port: number;
		expires: number;
		source: string;
		brokenUntil: number | null;
		/** broken because the wisp relay refused the UDP stream */
		refused: boolean;
	}[];
	connections: {
		origin: string;
		alive: boolean;
		stats: Record<string, number>;
	}[];
	/** how each of the last requests went: `h3`, `base`, or `base-after-h3` (an h3 failure retried) */
	recent: { url: string; via: 'h3' | 'base' | 'base-after-h3' }[];
}

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_WAIT_MS = 300;
/** quiche's floor for a retransmission timeout (kMinRetransmissionTimeMs) */
const MIN_RTO_MS = 200;
/** the RTT a connection is taken to have before it measured one (stomp-h3's initial_rtt) */
const INITIAL_RTT_MS = 100;
/** how long HTTP/3 stays off for every origin once the relay is taken to have no UDP */
const UDP_BLOCKED_MS = 5 * 60 * 1000;
/**
 * How many distinct hosts the relay must refuse a UDP stream to, with no
 * datagram having come back over the wisp connection, before the relay
 * itself is taken to have no UDP. A refusal costs two small wisp packets in
 * the background and no request waits on it, where a wrong verdict costs
 * every origin its HTTP/3, so the number errs high: more than the hosts of
 * one party a page usually opens with, and still reached within a page or
 * three behind a relay that has no UDP (docs/http3.md).
 */
const RELAY_REFUSALS = 8;
/**
 * The close reasons a wisp server also gives when it relays no UDP at all:
 * 0x48 (blocked: holyWisp with `allow-udp = off` or `proxy-udp = refuse`,
 * wisp-js and epoxy-server with UDP off) and 0x42 (unreachable:
 * wisp-server-python's --block-udp). Every other reason is about the
 * destination (0x03, 0x41, 0x43, 0x44, 0x47), the client's rate (0x49) or
 * this side (0x01, 0x02) and says nothing about the relay.
 */
const RELAY_REASONS = new Set([0x42, 0x48]);
/** epoxy's error for a UDP stream on a wisp v2 connection whose server did not announce the UDP extension */
const NO_UDP_EXTENSION =
	/ExtensionsNotSupported|Protocol extensions .* not supported/;
const DNS_NEGATIVE_MS = 5 * 60 * 1000;
const RECENT = 64;
/** methods a failed h3 attempt may be retried on the base transport with (RFC 9110 9.2.2, minus those with bodies that matter) */
const RETRYABLE = new Set(['GET', 'HEAD', 'OPTIONS']);

const STATUS_TEXT: Record<number, string> = {
	100: 'Continue',
	200: 'OK',
	201: 'Created',
	202: 'Accepted',
	204: 'No Content',
	206: 'Partial Content',
	301: 'Moved Permanently',
	302: 'Found',
	303: 'See Other',
	304: 'Not Modified',
	307: 'Temporary Redirect',
	308: 'Permanent Redirect',
	400: 'Bad Request',
	401: 'Unauthorized',
	403: 'Forbidden',
	404: 'Not Found',
	405: 'Method Not Allowed',
	409: 'Conflict',
	410: 'Gone',
	412: 'Precondition Failed',
	413: 'Payload Too Large',
	416: 'Range Not Satisfiable',
	429: 'Too Many Requests',
	500: 'Internal Server Error',
	502: 'Bad Gateway',
	503: 'Service Unavailable',
	504: 'Gateway Timeout',
};

/** what the UDP streams of one wisp connection have shown of its relay */
interface Relay {
	/** the base transport's client the streams are opened on; another one is another wisp connection */
	client: unknown;
	/** a datagram came back on some stream: the relay carries UDP */
	carried: boolean;
	/** hosts refused while nothing had been carried */
	refused: Set<string>;
	/** HTTP/3 is off for every origin until then */
	offUntil: number;
}

const hex = (reason: number) => `0x${reason.toString(16).padStart(2, '0')}`;

/** where an origin's requests go when HTTP/3 does not take them (the verbose log) */
const OVER_TCP = 'HTTP/2 or HTTP/1.1 over TLS over a Wisp TCP stream';

/** a key of the connections and the alt-svc cache, as the verbose log names it: the origin, and its partition */
function keyed(key: string): string {
	const at = key.lastIndexOf(' ');
	return at < 0 ? key : `${key.slice(at + 1)} (partition ${key.slice(0, at)})`;
}

const sleep = (ms: number) =>
	new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));

/**
 * How long Chrome lets a QUIC connection go without hearing from its peer
 * while it has packets out before it closes it as a blackhole
 * (QUIC_TOO_MANY_RTOS, "Network blackhole detected"): quiche's
 * GetNetworkBlackholeDelay for its default of two tail loss probes and
 * five retransmission timeouts, each twice the last. Measured in headless
 * Chrome 157 against test/wtserver.mjs with every datagram dropped after
 * the first request: the second request's connection was closed so 6.4 s
 * after it went out (an RTT of about 1 ms: 2 x 101.5 + 31 x 200 ms), and
 * Chrome sent the request again on a new connection. The mean deviation
 * quiche adds four times is taken as a quarter of the RTT (stomp-h3 reports
 * the smoothed RTT alone), which is what it settles near on a steady path;
 * under 200 ms of RTT the floor decides either way.
 */
export function blackholeDelay(rttMs: number): number {
	const srtt = rttMs > 0 ? rttMs : INITIAL_RTT_MS;
	const tlp = Math.max(2 * srtt, 1.5 * srtt + MIN_RTO_MS / 2);
	const rto = Math.max(srtt + 4 * (srtt / 4), MIN_RTO_MS);
	return Math.round(2 * tlp + 31 * rto);
}

/** `https://host[:port]` for a `force` entry given either way */
function forcedOrigin(entry: string): string | null {
	try {
		return new URL(entry.includes('://') ? entry : `https://${entry}`).origin;
	} catch {
		return null;
	}
}

/**
 * A body the h3 path can send, and whether it can be sent again on the base
 * transport if h3 fails. Everything but a stream is read into bytes the way
 * a Request would (with the content type it implies); a stream is teed.
 */
async function h3Body(body: BodyInit | null): Promise<{
	h3: Uint8Array | ReadableStream<Uint8Array> | null;
	retry: BodyInit | null;
	contentType: string | null;
}> {
	if (body === null || body === undefined)
		return { h3: null, retry: null, contentType: null };
	if (body instanceof ReadableStream) {
		const [a, b] = body.tee();
		return { h3: a, retry: b, contentType: null };
	}
	const request = new Request('https://h3.invalid/', { method: 'POST', body });
	const bytes = new Uint8Array(await request.arrayBuffer());
	return {
		h3: bytes,
		retry: bytes,
		contentType: request.headers.get('content-type'),
	};
}

/**
 * The request header list stomp-h3 sends: the caller's, lowercased, with the
 * base transport's Accept-Encoding left in its place (stomp-h3 writes the
 * codings it decodes into that field, so it goes out where Chrome sends it),
 * with User-Agent and (for a typed body) Content-Type added as epoxy adds them,
 * and Content-Length for a body whose length stomp-h3 has measured. Chrome
 * sends Content-Length over HTTP/3 for every body it has in hand; HTTP/1 and
 * HTTP/2 through hyper add it for a buffered body on their own, but stomp-h3
 * does not, so without this a server that needs a length refuses the request
 * (IIS answers 411 Length Required, as every Bing API POST did). A body of
 * unknown length (a page's own ReadableStream) goes out without one, as
 * natively, and a bodyless POST or PUT says zero, as Chrome's network stack
 * says it for those two methods only (a bodyless PATCH carries none).
 */
export function h3RequestHeaders(
	method: string,
	headers: RawHeaders,
	contentType: string | null,
	h3: Uint8Array | ReadableStream<Uint8Array> | null,
): RawHeaders {
	const out: RawHeaders = [];
	let agent = false;
	let type = false;
	let length = false;
	for (const [name, value] of headers) {
		const lower = name.toLowerCase();
		// the worker's word for the partition (Http3Transport.request), never
		// the server's
		if (lower === NETWORK_PARTITION) continue;
		agent ||= lower === 'user-agent';
		type ||= lower === 'content-type';
		length ||= lower === 'content-length';
		// stomp-h3 sends a byte a character; a value is the text whose UTF-8
		// the base transport sends (serveTransport's cookieText)
		out.push([lower, pastASCII(value) ? utf8Bytes(value) : value]);
	}
	// what epoxy adds when the caller leaves them out
	if (!agent) out.push(['user-agent', navigator.userAgent]);
	if (!type && contentType) out.push(['content-type', contentType]);
	const upper = method.toUpperCase();
	const bodyMethod = upper === 'POST' || upper === 'PUT';
	if (!length) {
		if (h3 instanceof Uint8Array)
			out.push(['content-length', String(h3.byteLength)]);
		else if (h3 === null && bodyMethod) out.push(['content-length', '0']);
	}
	return out;
}

export default class Http3Transport implements ProxyTransport {
	readonly base: ProxyTransport;
	#options: Http3Options;
	#moduleUrl: string | null;
	#workerUrl: string | null;
	#module: Promise<H3Module> | null = null;
	#moduleError: string | null = null;
	#cache = new AltSvcCache();
	#connections = new Map<string, H3Connection>();
	#pending = new Map<string, Promise<H3Connection | null>>();
	/** origins a QUIC handshake succeeded for in this session */
	#confirmed = new Set<string>();
	#relay: Relay = {
		client: undefined,
		carried: false,
		refused: new Set(),
		offUntil: 0,
	};
	#dnsAsked = new Map<string, number>();
	#recent: Http3Info['recent'] = [];
	/**
	 * Connections that ended because their wisp UDP stream did (the stream
	 * closed, or the wisp connection was lost): that says nothing about the
	 * origin's QUIC, so a request retried after one does not mark it broken
	 */
	#channelEnded = new WeakSet<H3Connection>();
	/** each connection's blackhole watch: a request to watch, and the call that ends its watch */
	#watches = new WeakMap<H3Connection, () => () => void>();

	/**
	 * `moduleUrl` is where stomp_h3.js lives (resolved by the host);
	 * `options.module` wins when given. `workerUrl` is a script that serves
	 * stomp-h3 when started as a worker named H3_WORKER_NAME (the transport
	 * worker's): stomp-h3 then runs on that thread (h3Thread.ts), or in this
	 * realm when that worker cannot start or load it.
	 */
	constructor(
		base: ProxyTransport,
		options: Http3Options = {},
		moduleUrl?: string,
		workerUrl?: string,
	) {
		this.base = base;
		this.#options = options;
		this.#moduleUrl = options.module ?? moduleUrl ?? null;
		this.#workerUrl = workerUrl ?? null;
		for (const entry of options.force || []) {
			const origin = forcedOrigin(entry);
			if (!origin) continue;
			const url = new URL(origin);
			this.#cache.add(origin, {
				host: url.hostname,
				port: Number(url.port) || 443,
				expires: Number.MAX_SAFE_INTEGER,
				source: 'force',
			});
		}
	}

	/**
	 * What the host may send (serveTransport's fitHeaders): Priority when the
	 * base keeps it to HTTP/2, which stomp-h3 sends over HTTP/3 as Chrome
	 * does (without this the field was dropped from every request of a host
	 * that turned HTTP/3 on), and the base's Accept-Encoding, in the host's
	 * place among the fields: the base put its own before Accept-Language,
	 * which is not where Chrome sends it when the page set that field.
	 * stomp-h3 keeps the field in that place and gives it the codings it
	 * decodes (Chrome's gzip, deflate, br, zstd)
	 */
	get fieldSupport(): {
		priority?: boolean;
		partition?: string;
		httpVersion?: boolean;
		acceptEncoding?: string;
	} {
		const base = (
			this.base as {
				fieldSupport?: {
					priority?: boolean;
					partition?: string;
					httpVersion?: boolean;
					acceptEncoding?: string;
				};
			}
		).fieldSupport;
		return {
			priority: !!base?.priority,
			...(base?.partition && { partition: base.partition }),
			// an HTTP/3 response says so itself (#viaH3)
			...(base?.httpVersion && { httpVersion: true }),
			...(base?.acceptEncoding && { acceptEncoding: base.acceptEncoding }),
		};
	}

	get ready(): boolean {
		return this.base.ready;
	}
	set ready(value: boolean) {
		this.base.ready = value;
	}

	init(): Promise<void> {
		return this.base.init();
	}

	async meta(): Promise<void> {
		await (this.base as { meta?: () => Promise<void> }).meta?.();
	}

	connect(...args: Parameters<ProxyTransport['connect']>) {
		return this.base.connect(...args);
	}

	/** what the wrapper knows: alt-svc entries, connections, the last requests */
	info(): Http3Info {
		return {
			enabled: !!this.#udp() && !this.#moduleError,
			moduleError: this.#moduleError,
			udpBlockedUntil:
				this.#relay.offUntil > Date.now() ? this.#relay.offUntil : null,
			udpCarried: this.#relay.carried,
			udpRefused: [...this.#relay.refused],
			altSvc: this.#cache
				.entries()
				.map(({ origin, entry, brokenUntil, refused }) => ({
					origin,
					port: entry.port,
					expires: entry.expires,
					source: entry.source,
					brokenUntil,
					refused,
				})),
			connections: [...this.#connections].map(([origin, conn]) => ({
				origin,
				alive: conn.alive,
				stats: conn.alive ? conn.stats() : {},
			})),
			recent: [...this.#recent],
		};
	}

	/** close every QUIC connection (they also close themselves after 30 s idle) */
	closeAll(): void {
		for (const conn of this.#connections.values()) conn.close();
		this.#connections.clear();
	}

	async request(
		remote: URL,
		method: string,
		body: BodyInit | null,
		headers: RawHeaders,
		signal: AbortSignal | undefined,
	): Promise<TransferrableResponse> {
		const origin = remote.origin;
		// what it knows of an origin and the QUIC connections it keeps are
		// the request's network partition's (the field the service worker
		// names it in), as Chrome keys them by the top-level site: a page of
		// one site does not find a QUIC connection another site's opened
		const partition = Array.isArray(headers)
			? headers.find(([name]) => name.toLowerCase() === NETWORK_PARTITION)?.[1]
			: undefined;
		const key = partition ? `${partition} ${origin}` : origin;
		const usable = remote.protocol === 'https:' && !!this.#udp();
		// an origin the last wisp connection's relay refused is not broken
		// on a new one
		if (usable) this.#currentRelay();
		const alt = usable ? this.#lookup(key, origin) : null;
		let retryBody = body;
		let via: Http3Info['recent'][number]['via'] = 'base';
		/** the QUIC connection that failed under this request, when it did */
		let failed: H3Connection | null = null;

		if (alt) {
			const conn = await this.#connectionFor(key, alt);
			if (conn) {
				const prepared = await h3Body(body);
				retryBody = prepared.retry;
				// watched until it is heard from (blackholeDelay)
				const unwatch = this.#watches.get(conn)?.();
				try {
					const response = await this.#viaH3(
						conn,
						remote,
						method,
						prepared,
						headers,
					).finally(() => unwatch?.());
					this.#note(remote, 'h3');
					this.#learn(key, remote, response.headers);
					// the copy kept for a retry is not needed
					if (prepared.retry instanceof ReadableStream)
						void prepared.retry.cancel().catch(() => {});
					return response;
				} catch (error) {
					if (!conn.alive) {
						this.#lost(key, conn);
						failed = conn;
					}
					// a request whose stream never opened never reached the
					// server, whatever its method
					const unsent = /^h3 send:/.test(String((error as Error)?.message));
					if (!unsent && !RETRYABLE.has(method.toUpperCase())) throw error;
					console.warn(
						`Stomp: HTTP/3 request to ${origin} failed, retrying over the base transport:`,
						error,
					);
					if (transportLog.on)
						logTransport(
							`HTTP/3 to ${keyed(key)}: a ${method.toUpperCase()} failed (${String((error as Error)?.message ?? error).slice(0, 160)}), sent again with ${OVER_TCP}`,
						);
					via = 'base-after-h3';
				}
			}
		} else if (usable && this.#options.dns) {
			void this.#askDns(key, remote);
		}

		const response = await this.base.request(
			remote,
			method,
			retryBody,
			headers,
			signal,
		);
		this.#note(remote, via);
		// As Chrome: a request whose QUIC connection failed under it (a
		// blackhole, the idle timeout, an error of the connection's) is sent
		// again without the alternative, and when that answers, the
		// alternative is marked broken (HttpNetworkTransaction's retry
		// without alt-svc on ERR_QUIC_PROTOCOL_ERROR). Without it every
		// request after one reconnected, waited out the same failure, and
		// was sent again: a QUIC path that carried the handshake and not the
		// requests held each of a page's requests to that origin until its
		// connection's idle timeout, for good.
		if (failed && !this.#channelEnded.has(failed) && this.#cache.lookup(key)) {
			const delay = this.#cache.markBroken(key);
			console.warn(
				`Stomp: HTTP/3 to ${origin} failed under a request that the base transport answered; HTTP/3 off for it for ${Math.round(delay / 1000)} s`,
			);
		}
		if (usable) {
			// the base transport may have answered over a new wisp connection
			this.#currentRelay();
			this.#learn(key, remote, response.headers);
		}
		return response;
	}

	#note(remote: URL, via: Http3Info['recent'][number]['via']) {
		this.#recent.push({ url: remote.href, via });
		if (this.#recent.length > RECENT) this.#recent.shift();
	}

	/**
	 * The alternative for `origin` in the partition `key` names: its own
	 * entry, else a forced one (`force`, kept under the origin alone), which
	 * the partition takes as its own so that a failure there is its own
	 */
	#lookup(key: string, origin: string): AltService | null {
		const own = this.#cache.lookup(key);
		if (own || key === origin || this.#cache.known(key)) return own;
		const forced = this.#cache.lookup(origin);
		if (forced?.source !== 'force') return null;
		this.#cache.add(key, forced);
		return forced;
	}

	/** Alt-Svc from any response of an https origin updates its entry (under `key`, its partition's) */
	#learn(key: string, remote: URL, headers: RawHeaders) {
		const values = headers
			.filter(([name]) => name.toLowerCase() === 'alt-svc')
			.map(([, value]) => value);
		if (!values.length) return;
		const before = this.#cache.lookup(key);
		this.#cache.learn(key, remote.hostname, values);
		const after = this.#cache.lookup(key);
		// a newly learned (or moved) alternative: connect now, so the next
		// request finds it up
		if (after && (!before || before.port !== after.port))
			void this.#connectionFor(key, after);
	}

	/** the base transport's UDP opener (epoxy's `client.connect_udp`), or the host's */
	#udp(): UdpOpener | null {
		if (this.#options.udp) return this.#options.udp;
		const client = (
			this.base as {
				client?: { connect_udp?: (url: string) => Promise<DatagramChannel> };
			}
		).client;
		if (!this.base.ready || typeof client?.connect_udp !== 'function')
			return null;
		return (host, port) =>
			client.connect_udp!(
				`udp://${host.includes(':') ? `[${host}]` : host}:${port}`,
			);
	}

	/**
	 * What is known of the relay behind the wisp connection in use. The
	 * base transport builds a new client when its wisp connection is lost
	 * (RevivingTransport), and another edge may answer the new one, so
	 * nothing learned over the old connection is kept.
	 */
	#currentRelay(): Relay {
		const client = (this.base as { client?: unknown }).client;
		if (client !== this.#relay.client) this.#newRelay();
		return this.#relay;
	}

	/** a new wisp connection: no verdict, no refusals counted, and what the old relay refused is tried again */
	#newRelay(): void {
		this.#relay = {
			client: (this.base as { client?: unknown }).client,
			carried: false,
			refused: new Set(),
			offUntil: 0,
		};
		this.#cache.forgetRefused();
	}

	/** a datagram came back on a stream of `relay`: it carries UDP, whatever was refused */
	#carried(relay: Relay): void {
		if (relay !== this.#relay || relay.carried) return;
		relay.carried = true;
		relay.refused.clear();
		if (relay.offUntil > Date.now())
			console.warn('Stomp: HTTP/3 is on again, the wisp server does relay UDP');
		relay.offUntil = 0;
	}

	/**
	 * The relay closed the UDP stream to `alt.host` before anything came
	 * back on it (`reason`: the wisp close reason, when the transport
	 * reports it), or the stream could not be opened. That is a failure of
	 * this origin. It counts against the relay only while no datagram has
	 * come back over the wisp connection and the reason is one a server
	 * without UDP gives too (or is not known).
	 */
	#refused(
		relay: Relay,
		origin: string,
		alt: AltService,
		reason: number | undefined,
		detail: string,
	): void {
		const delay = this.#cache.markBroken(origin, true);
		console.warn(
			`Stomp: the wisp server refused UDP to ${alt.host}:${alt.port} (${detail}); HTTP/3 off for ${origin} for ${Math.round(delay / 1000)} s`,
		);
		if (transportLog.on)
			logTransport(
				`HTTP/3 to ${keyed(origin)} falls back: the wisp server refused the Wisp UDP stream to ${alt.host}:${alt.port} (${detail}); ${OVER_TCP} for ${Math.round(delay / 1000)} s`,
			);
		if (relay !== this.#relay || relay.carried) return;
		if (reason !== undefined && !RELAY_REASONS.has(reason)) return;
		relay.refused.add(alt.host.toLowerCase());
		if (relay.refused.size < RELAY_REFUSALS) return;
		this.#relayOff(
			relay,
			`UDP streams to ${relay.refused.size} hosts refused and none carried`,
		);
	}

	/** the relay is taken to have no UDP: no origin is tried for a while, then the evidence is gathered again */
	#relayOff(relay: Relay, why: string): void {
		relay.offUntil = Date.now() + UDP_BLOCKED_MS;
		relay.refused.clear();
		console.warn(
			`Stomp: HTTP/3 is off for ${UDP_BLOCKED_MS / 1000} s, the wisp server relays no UDP (${why})`,
		);
		if (transportLog.on)
			logTransport(
				`HTTP/3 falls back for every origin: the wisp server relays no UDP (${why}); ${OVER_TCP} for ${UDP_BLOCKED_MS / 1000} s`,
			);
	}

	#loadModule(): Promise<H3Module> {
		this.#module ??= (async () => {
			if (!this.#moduleUrl)
				throw new Error('no stomp-h3 module URL (http3.module)');
			if (this.#workerUrl && typeof Worker === 'function')
				try {
					return await remoteH3Module(this.#moduleUrl, this.#workerUrl);
				} catch (error) {
					console.warn(
						'Stomp: stomp-h3 runs in the transport worker, its own worker did not start:',
						error,
					);
				}
			const module = (await import(
				/* @vite-ignore */ this.#moduleUrl
			)) as H3Module;
			await module.default();
			return module;
		})().catch((error) => {
			this.#moduleError = String(error?.message || error);
			console.warn('Stomp: HTTP/3 is off, stomp-h3 did not load:', error);
			if (transportLog.on)
				logTransport(
					`HTTP/3 falls back for every origin: stomp-h3 did not load (${this.#moduleError}); ${OVER_TCP}`,
				);
			throw error;
		});
		return this.#module;
	}

	/**
	 * The live connection to `origin`, or null when the request should go
	 * over the base transport now. A connection that is not up yet is
	 * started in the background; the request waits for it only when QUIC
	 * already worked for this origin (a reconnect after an idle close, at
	 * most `wait` ms) or the origin is forced (up to the handshake timeout).
	 */
	async #connectionFor(
		origin: string,
		alt: AltService,
	): Promise<H3Connection | null> {
		const live = this.#connections.get(origin);
		if (live?.alive) return live;
		if (live) this.#connections.delete(origin);
		if (this.#currentRelay().offUntil > Date.now() || this.#moduleError)
			return null;

		let pending = this.#pending.get(origin);
		if (!pending) {
			pending = this.#connect(origin, alt).finally(() =>
				this.#pending.delete(origin),
			);
			this.#pending.set(origin, pending);
		}
		const wait =
			alt.source === 'force'
				? (this.#options.timeout ?? DEFAULT_TIMEOUT_MS) + 1000
				: this.#confirmed.has(origin)
					? (this.#options.wait ?? DEFAULT_WAIT_MS)
					: 0;
		if (!wait) return null;
		return Promise.race([pending, sleep(wait)]);
	}

	async #connect(
		origin: string,
		alt: AltService,
	): Promise<H3Connection | null> {
		const udp = this.#udp();
		if (!udp) return null;
		let module: H3Module;
		try {
			module = await this.#loadModule();
		} catch {
			return null;
		}
		// the relay this stream is opened on; a verdict about another wisp
		// connection's relay is not this stream's to give
		const relay = this.#currentRelay();
		let channel: DatagramChannel;
		try {
			channel = await udp(alt.host, alt.port);
		} catch (error) {
			const message = String((error as Error)?.message ?? error);
			// the wisp connection itself is gone: the base transport opens a
			// new one, and what its relay does is not known yet
			if (wispGone(error)) {
				if (relay === this.#relay) this.#newRelay();
				return null;
			}
			// the server said so itself: a wisp v2 server that did not
			// announce the UDP extension relays UDP to nobody
			if (NO_UDP_EXTENSION.test(message)) {
				if (relay === this.#relay) this.#relayOff(relay, message);
				return null;
			}
			this.#refused(relay, origin, alt, undefined, message);
			return null;
		}
		// A channel that ends under a live connection (its wisp stream closed,
		// or the whole wisp connection was lost) ends the connection now.
		// stomp-h3 only marks it dead, and the requests on it would wait for
		// the 30 s idle timeout before failing over to the base transport.
		let conn: H3Connection | null = null;
		let ended = false;
		const end = () => {
			if (ended) return;
			ended = true;
			stopWatch();
			if (!conn) return;
			this.#channelEnded.add(conn);
			conn.close();
			this.#lost(origin, conn);
		};
		// Chrome's blackhole detection (blackholeDelay): a request sent and
		// nothing heard back since. stomp-h3 (quinn) has none: with every
		// small datagram lost it sent a handful of probes and then waited
		// for the 30 s idle timeout, so a QUIC path that took the handshake
		// and then carried nothing (a wisp relay's datagrams lost while its
		// stream carries, as over a WebTransport session whose datagrams do
		// not get through) held every request that long. A server
		// acknowledges a request within its max_ack_delay (25 ms) whether or
		// not it answers it yet, so a request it holds (a long poll) is
		// heard from. A request is timed from the first datagram that went
		// out after it was made: one waiting for a stream sends nothing.
		// Requests whose first datagram went out and nothing was heard
		// since, by when that was
		const unheard = new Map<object, number>();
		/** requests made and not yet sent */
		const unsent = new Set<object>();
		let silence: ReturnType<typeof setTimeout> | undefined;
		const stopWatch = () => {
			clearTimeout(silence);
			silence = undefined;
		};
		// The delay by the RTT, read only from a timer or a microtask: the
		// writes and reads below are called from inside stomp-h3's wasm, and
		// a call back into the connection there (its stats) throws (a
		// recursive use of the Rust object), which errored the writer and
		// left every request on the connection unsent.
		let wait = blackholeDelay(0);
		const measure = () => {
			try {
				if (conn?.alive) wait = blackholeDelay(Number(conn.stats().rttMs));
			} catch {
				// still inside the wasm: the last measure stands
			}
		};
		const blackhole = () => {
			silence = undefined;
			if (ended || !conn?.alive || !unheard.size) return;
			const since = Math.min(...unheard.values());
			const waited = performance.now() - since;
			measure();
			if (waited < wait) return rearm();
			const live = conn;
			console.warn(
				`Stomp: QUIC to ${origin} heard nothing back for ${Math.round(waited)} ms after a request (a blackhole, as Chrome closes one); its requests go over the base transport`,
			);
			live.close();
			this.#lost(origin, live);
		};
		const rearm = () => {
			stopWatch();
			if (ended || !unheard.size) return;
			const since = Math.min(...unheard.values());
			silence = setTimeout(
				blackhole,
				Math.max(0, since + wait - performance.now()),
			);
		};
		// anything heard: every request out is acknowledged by now or will
		// be, and is no longer watched
		const heard = () => {
			if (!unheard.size) return;
			unheard.clear();
			stopWatch();
			queueMicrotask(measure);
		};
		const sent = () => {
			if (!unsent.size) return;
			const now = performance.now();
			for (const request of unsent) unheard.set(request, now);
			unsent.clear();
			if (silence === undefined) rearm();
		};
		/** a request on the connection, watched until it is heard from or the returned call */
		const watchRequest = () => {
			const request = {};
			unsent.add(request);
			return () => {
				unsent.delete(request);
				if (unheard.delete(request) && !unheard.size) stopWatch();
			};
		};
		// the first datagram back shows the relay carries UDP
		let received = false;
		// stomp-h3 closes its writer when it gives up on the connection, and
		// the stream then ends because this side closed it. A stream that
		// ends before that was ended from the other side: `cut`.
		let released = false;
		let cut = false;
		const readEnded = () => {
			if (!released) cut = true;
			end();
		};
		// Every datagram stomp-h3 reads is pulled from the channel here, one
		// read each, where a TransformStream piped to cost each datagram a
		// read, a write, a transform and their promises: a QUIC response is
		// about 800 datagrams a MB
		const source = channel.read.getReader();
		const watch = {
			readable: new ReadableStream<Uint8Array>(
				{
					pull: async (controller) => {
						let next: ReadableStreamReadResult<Uint8Array>;
						try {
							next = await source.read();
						} catch (error) {
							readEnded();
							controller.error(error);
							return;
						}
						if (next.done) {
							readEnded();
							controller.close();
							return;
						}
						if (!received) {
							received = true;
							this.#carried(relay);
						}
						heard();
						controller.enqueue(next.value);
					},
					cancel: (reason) => source.cancel(reason),
				},
				// one datagram read ahead, as the pipe read: the channel's end
				// and its first datagram are seen while stomp-h3 is not reading
				{ highWaterMark: 1 },
			),
		};
		// A datagram that cannot go out means the same. stomp-h3 closes its
		// writer when the connection goes without waiting on it, and closing
		// an errored stream rejects with no one to catch it, so a failed write
		// ends the connection here and leaves this stream open.
		const out = channel.write.getWriter();
		const write = new WritableStream<Uint8Array>({
			write: (chunk) => {
				// the watch never stands in a datagram's way
				try {
					sent();
				} catch {
					// unwatched
				}
				return out.write(chunk).catch(end);
			},
			close: () => {
				released = true;
				stopWatch();
				return out.close().catch(() => {});
			},
			abort: (reason) => {
				released = true;
				stopWatch();
				return out.abort(reason).catch(() => {});
			},
		});
		try {
			conn = await module.connect(alt.host, watch.readable, write, {
				...(this.#options.pem ? { pem: this.#options.pem } : {}),
				timeoutMs: this.#options.timeout ?? DEFAULT_TIMEOUT_MS,
			});
			if (ended) {
				conn.close();
				return null;
			}
			this.#connections.set(origin, conn);
			this.#watches.set(conn, watchRequest);
			measure();
			this.#confirmed.add(origin);
			this.#cache.confirm(origin);
			if (transportLog.on)
				logTransport(
					`HTTP/3 to ${keyed(origin)}: QUIC over a Wisp UDP stream to ${alt.host}:${alt.port}, ${rideOf(this, true)}; handshake ${Math.round(conn.handshake_ms)} ms, from ${alt.source === 'alt-svc' ? 'Alt-Svc' : alt.source === 'dns' ? 'an HTTPS DNS record' : 'force'}`,
				);
			return conn;
		} catch (error) {
			const message = String((error as Error)?.message || error);
			// A stream the wisp server closed before a datagram came back
			// on it was refused: wisp has no answer to CONNECT, so a server
			// that will not relay a stream closes it, at once or when the
			// first datagram for it arrives. The refusal is of this
			// destination (a name the relay will not send UDP to, a blocked
			// or unreachable host); whether it is also evidence about the
			// relay is #refused's to say.
			if (cut && !received) {
				const reason = channel.closeReason?.();
				this.#refused(
					relay,
					origin,
					alt,
					reason,
					reason === undefined
						? 'the stream was closed before anything came back'
						: `close reason ${hex(reason)}`,
				);
				return null;
			}
			const delay = this.#cache.markBroken(origin);
			console.warn(
				`Stomp: QUIC to ${origin} failed (${message}); HTTP/3 off for it for ${Math.round(delay / 1000)} s`,
			);
			if (transportLog.on)
				logTransport(
					`HTTP/3 to ${keyed(origin)} falls back: QUIC failed (${message}); ${OVER_TCP} for ${Math.round(delay / 1000)} s`,
				);
			return null;
		}
	}

	/** a connection that died under a request: drop it; the next request reconnects */
	#lost(origin: string, conn: H3Connection) {
		if (this.#connections.get(origin) !== conn) return;
		this.#connections.delete(origin);
		if (transportLog.on)
			logTransport(
				`HTTP/3 to ${keyed(origin)}: the QUIC connection ended; ${OVER_TCP} until a new one is up`,
			);
	}

	async #viaH3(
		conn: H3Connection,
		remote: URL,
		method: string,
		body: Awaited<ReturnType<typeof h3Body>>,
		headers: RawHeaders,
	): Promise<TransferrableResponse> {
		const out = h3RequestHeaders(method, headers, body.contentType, body.h3);
		const response = await conn.request(
			method.toUpperCase(),
			remote.href,
			out,
			body.h3,
		);
		return {
			body: response.body as unknown as TransferrableResponse['body'],
			headers: response.headers,
			status: response.status,
			statusText: STATUS_TEXT[response.status] ?? '',
			// one QUIC connection takes every request (socketPool.ts)
			httpVersion: '3',
		} as TransferrableResponse;
	}

	/** ask the DoH server for `remote`'s HTTPS record, once per name per answer's TTL */
	async #askDns(key: string, remote: URL) {
		const origin = key;
		if (remote.port && remote.port !== '443') return;
		if (this.#cache.known(origin)) return;
		const name = remote.hostname;
		if (/^[\d.]+$|:/.test(name)) return;
		const until = this.#dnsAsked.get(name);
		if (until && until > Date.now()) return;
		this.#dnsAsked.set(name, Date.now() + DNS_NEGATIVE_MS);
		try {
			const url = new URL(this.#options.dns!);
			url.searchParams.set('dns', base64url(httpsQuery(name)));
			const response = await this.base.request(
				url,
				'GET',
				null,
				[['accept', 'application/dns-message']],
				undefined,
			);
			if (response.status !== 200) return;
			const record = parseHttpsAnswer(
				await new Response(response.body as BodyInit).arrayBuffer(),
			);
			if (!record) return;
			this.#dnsAsked.set(
				name,
				Date.now() + Math.max(record.ttl * 1000, DNS_NEGATIVE_MS),
			);
			if (!record.h3) return;
			const entry: AltService = {
				host: name,
				port: record.port ?? 443,
				expires: Date.now() + Math.max(record.ttl, 60) * 1000,
				source: 'dns',
			};
			this.#cache.add(origin, entry);
			void this.#connectionFor(origin, entry);
		} catch (error) {
			console.warn(`Stomp: HTTPS record lookup for ${name} failed:`, error);
		}
	}
}
