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
import { wispGone } from '../RevivingTransport';
import { AltSvcCache, type AltService } from './altSvc';
import { base64url, httpsQuery, parseHttpsAnswer } from './dnsHttps';

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

interface H3Response {
	status: number;
	headers: RawHeaders;
	body: ReadableStream<Uint8Array> | null;
}
interface H3Connection {
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
interface H3Module {
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

const sleep = (ms: number) =>
	new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));

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

export default class Http3Transport implements ProxyTransport {
	readonly base: ProxyTransport;
	#options: Http3Options;
	#moduleUrl: string | null;
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
	 * `moduleUrl` is where stomp_h3.js lives (resolved by the host);
	 * `options.module` wins when given.
	 */
	constructor(
		base: ProxyTransport,
		options: Http3Options = {},
		moduleUrl?: string,
	) {
		this.base = base;
		this.#options = options;
		this.#moduleUrl = options.module ?? moduleUrl ?? null;
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
	 * that turned HTTP/3 on); no Accept-Encoding, since stomp-h3 decodes gzip
	 * and br only and names them itself
	 */
	get fieldSupport(): { priority?: boolean } {
		const base = (this.base as { fieldSupport?: { priority?: boolean } })
			.fieldSupport;
		return { priority: !!base?.priority };
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
		const usable = remote.protocol === 'https:' && !!this.#udp();
		// an origin the last wisp connection's relay refused is not broken
		// on a new one
		if (usable) this.#currentRelay();
		const alt = usable ? this.#cache.lookup(origin) : null;
		let retryBody = body;
		let via: Http3Info['recent'][number]['via'] = 'base';

		if (alt) {
			const conn = await this.#connectionFor(origin, alt);
			if (conn) {
				const prepared = await h3Body(body);
				retryBody = prepared.retry;
				try {
					const response = await this.#viaH3(
						conn,
						remote,
						method,
						prepared,
						headers,
					);
					this.#note(remote, 'h3');
					this.#learn(remote, response.headers);
					// the copy kept for a retry is not needed
					if (prepared.retry instanceof ReadableStream)
						void prepared.retry.cancel().catch(() => {});
					return response;
				} catch (error) {
					if (!conn.alive) this.#lost(origin, conn);
					// a request whose stream never opened never reached the
					// server, whatever its method
					const unsent = /^h3 send:/.test(String((error as Error)?.message));
					if (!unsent && !RETRYABLE.has(method.toUpperCase())) throw error;
					console.warn(
						`Stomp: HTTP/3 request to ${origin} failed, retrying over the base transport:`,
						error,
					);
					via = 'base-after-h3';
				}
			}
		} else if (usable && this.#options.dns) {
			void this.#askDns(remote);
		}

		const response = await this.base.request(
			remote,
			method,
			retryBody,
			headers,
			signal,
		);
		this.#note(remote, via);
		if (usable) {
			// the base transport may have answered over a new wisp connection
			this.#currentRelay();
			this.#learn(remote, response.headers);
		}
		return response;
	}

	#note(remote: URL, via: Http3Info['recent'][number]['via']) {
		this.#recent.push({ url: remote.href, via });
		if (this.#recent.length > RECENT) this.#recent.shift();
	}

	/** Alt-Svc from any response of an https origin updates its entry */
	#learn(remote: URL, headers: RawHeaders) {
		const values = headers
			.filter(([name]) => name.toLowerCase() === 'alt-svc')
			.map(([, value]) => value);
		if (!values.length) return;
		const before = this.#cache.lookup(remote.origin);
		this.#cache.learn(remote.origin, remote.hostname, values);
		const after = this.#cache.lookup(remote.origin);
		// a newly learned (or moved) alternative: connect now, so the next
		// request finds it up
		if (after && (!before || before.port !== after.port))
			void this.#connectionFor(remote.origin, after);
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
	}

	#loadModule(): Promise<H3Module> {
		this.#module ??= (async () => {
			if (!this.#moduleUrl)
				throw new Error('no stomp-h3 module URL (http3.module)');
			const module = (await import(
				/* @vite-ignore */ this.#moduleUrl
			)) as H3Module;
			await module.default();
			return module;
		})().catch((error) => {
			this.#moduleError = String(error?.message || error);
			console.warn('Stomp: HTTP/3 is off, stomp-h3 did not load:', error);
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
			if (!conn) return;
			conn.close();
			this.#lost(origin, conn);
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
		const watch = new TransformStream<Uint8Array, Uint8Array>({
			transform: (chunk, controller) => {
				if (!received) {
					received = true;
					this.#carried(relay);
				}
				controller.enqueue(chunk);
			},
			flush: readEnded,
		});
		channel.read.pipeTo(watch.writable).catch(readEnded);
		// A datagram that cannot go out means the same. stomp-h3 closes its
		// writer when the connection goes without waiting on it, and closing
		// an errored stream rejects with no one to catch it, so a failed write
		// ends the connection here and leaves this stream open.
		const out = channel.write.getWriter();
		const write = new WritableStream<Uint8Array>({
			write: (chunk) => out.write(chunk).catch(end),
			close: () => {
				released = true;
				return out.close().catch(() => {});
			},
			abort: (reason) => {
				released = true;
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
			this.#confirmed.add(origin);
			this.#cache.confirm(origin);
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
			return null;
		}
	}

	/** a connection that died under a request: drop it; the next request reconnects */
	#lost(origin: string, conn: H3Connection) {
		if (this.#connections.get(origin) === conn)
			this.#connections.delete(origin);
	}

	async #viaH3(
		conn: H3Connection,
		remote: URL,
		method: string,
		body: Awaited<ReturnType<typeof h3Body>>,
		headers: RawHeaders,
	): Promise<TransferrableResponse> {
		const out: RawHeaders = [];
		let agent = false;
		let type = false;
		for (const [name, value] of headers) {
			const lower = name.toLowerCase();
			agent ||= lower === 'user-agent';
			type ||= lower === 'content-type';
			out.push([lower, value]);
		}
		// what epoxy adds when the caller leaves them out
		if (!agent) out.push(['user-agent', navigator.userAgent]);
		if (!type && body.contentType) out.push(['content-type', body.contentType]);
		const upper = method.toUpperCase();
		if (
			body.h3 === null &&
			(upper === 'POST' || upper === 'PUT' || upper === 'PATCH')
		)
			out.push(['content-length', '0']);
		const response = await conn.request(upper, remote.href, out, body.h3);
		return {
			body: response.body as unknown as TransferrableResponse['body'],
			headers: response.headers,
			status: response.status,
			statusText: STATUS_TEXT[response.status] ?? '',
		};
	}

	/** ask the DoH server for `remote`'s HTTPS record, once per name per answer's TTL */
	async #askDns(remote: URL) {
		const origin = remote.origin;
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
