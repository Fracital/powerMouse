// Wisp over WebTransport (holyWisp's WebTransport listener, its
// docs/webtransport.md, "Wisp on the session"): the same Wisp packets a
// WebSocket would carry, on one bidirectional stream of a WebTransport
// session, each after its length as a u32 LE; and a UDP stream's DATA, when
// it fits, as one QUIC datagram (no prefix), so a lost datagram of a QUIC or
// WebRTC flow inside is lost rather than holding up every other stream.
//
// Where the session is:
// - `url`: dialed as it is, its certificate checked as any site's (a relay
//   with a public name and a WebPKI certificate, as the edges serve it);
// - `discovery`, or with neither `/webtransport.json` on the wisp URL's
//   origin: a document `{ url, hashes: [{ algorithm, value }] }` (value in
//   base64; the current certificate and the previous one, which a relay with
//   no public name makes itself every 6 days). Every hash goes in one
//   handshake, as Chrome takes a certificate whose hash is any of them; one
//   that fails is tried once more after the document is fetched again (it
//   may have rotated between the two). A document that lists no `url` names
//   its own origin;
// - with neither set and no document at the wisp URL's origin, a wss: wisp
//   URL is dialed as https: (its path kept: a keyed relay needs it).
//
// The WebSocket is never kept waiting on UDP, which is often blocked: the
// carrier is chosen when the transport starts (CarrierTransport.init) from
// what this relay did before (`memory`, kept in IndexedDB across reloads):
// - nothing known: the WebSocket at once, and a session tried beside it whose
//   outcome is remembered, so the next transport (a revive, a reload) knows;
// - the session worked: the session, within `timeoutMs`, else the WebSocket;
// - it failed (no session, a timeout, a session that died under its
//   requests): the WebSocket, without trying, for FAILED_FOR_MS, or until
//   the network changes (`online`, a connection change).
// A transport keeps its carrier: when the session ends, its packets'
// readable ends as a closed WebSocket's does, and the next wisp connection
// epoxy asks for fails as a dead one does (CARRIER_LOST), so
// RevivingTransport builds a new transport that chooses again.
import type {
	ProxyTransport,
	RawHeaders,
	TransferrableResponse,
} from '@mercuryworkshop/proxy-transports';

/** TransportDescriptor.webTransport */
export interface WispWebTransportOptions {
	/**
	 * the session's https: URL, its certificate checked as any site's (no
	 * discovery document)
	 */
	url?: string;
	/**
	 * the relay's discovery document, resolved against the wisp URL (an
	 * absolute one may name another host's); `/webtransport.json` on the
	 * wisp URL's origin (ws: as http:, wss: as https:) when neither this nor
	 * `url` is set
	 */
	discovery?: string;
	/** how long the document and then the session's handshake may take (ms) */
	timeoutMs?: number;
}

/** the text RevivingTransport takes for a wisp connection that is gone (its DEAD) */
export const CARRIER_LOST = 'WebTransportCarrierLost';

const DEFAULT_TIMEOUT_MS = 2000;
/** how long a relay whose session could not be had is left to the WebSocket */
const FAILED_FOR_MS = 5 * 60 * 1000;
/** how long a session that worked is gone to again without the WebSocket first */
const WORKED_FOR_MS = 7 * 24 * 60 * 60 * 1000;
/** the protocol offered for Wisp v2 (holyWisp takes any; its own client offers this) */
const V2_PROTOCOL = 'wisp-v2';

const DATA = 0x02;
const CONNECT = 0x01;
const CLOSE = 0x04;
const UDP = 0x02;

/** where a relay's session is looked for, and what it is remembered by */
export interface RelayPlan {
	key: string;
	discovery?: string;
	direct?: string;
}

/** the plan for a wisp URL and its options */
export function relayPlan(
	wisp: string,
	options: WispWebTransportOptions,
): RelayPlan {
	if (options.discovery) {
		const discovery = new URL(options.discovery, wisp).href;
		return { key: discovery, discovery };
	}
	if (options.url) {
		const direct = new URL(options.url, wisp).href;
		return { key: direct, direct };
	}
	const url = new URL(wisp);
	const secure = url.protocol === 'wss:';
	url.protocol = secure ? 'https:' : 'http:';
	const discovery = new URL('/webtransport.json', url).href;
	return {
		key: `wisp ${wisp}`,
		discovery,
		...(secure && { direct: url.href }),
	};
}

type Verdict = 'worked' | 'failed';
interface Remembered {
	verdict: Verdict;
	until: number;
}

/**
 * What each relay's session did, by RelayPlan.key: in this realm, and in
 * IndexedDB for the next page or worker of this origin. Storage that cannot
 * be had (a private window's, a sandbox's) only loses the second.
 */
export const memory = (() => {
	const known = new Map<string, Remembered>();
	const STORE = 'relays';
	let opened: Promise<IDBDatabase | null> | null = null;
	const db = () =>
		(opened ??= new Promise<IDBDatabase | null>((resolve) => {
			try {
				const request = indexedDB.open('stomp-wisp-carrier', 1);
				request.onupgradeneeded = () => request.result.createObjectStore(STORE);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => resolve(null);
				request.onblocked = () => resolve(null);
			} catch {
				resolve(null);
			}
		}));
	const run = async <T>(
		mode: IDBTransactionMode,
		work: (store: IDBObjectStore) => IDBRequest<T>,
	): Promise<T | undefined> => {
		const database = await db();
		if (!database) return undefined;
		return new Promise((resolve) => {
			try {
				const request = work(
					database.transaction(STORE, mode).objectStore(STORE),
				);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => resolve(undefined);
			} catch {
				resolve(undefined);
			}
		});
	};
	const live = (entry: Remembered | undefined) =>
		entry && entry.until > Date.now() ? entry.verdict : undefined;
	const api = {
		async get(key: string): Promise<Verdict | undefined> {
			if (known.has(key)) return live(known.get(key));
			const stored = (await run('readonly', (store) => store.get(key))) as
				Remembered | undefined;
			if (stored && !known.has(key)) known.set(key, stored);
			return live(known.get(key));
		},
		set(key: string, verdict: Verdict) {
			const entry = {
				verdict,
				until:
					Date.now() + (verdict === 'worked' ? WORKED_FOR_MS : FAILED_FOR_MS),
			};
			known.set(key, entry);
			void run('readwrite', (store) => store.put(entry, key));
		},
		/** nothing known any more: the next start tries beside the WebSocket */
		forget(key: string) {
			known.delete(key);
			void run('readwrite', (store) => store.delete(key));
		},
		/** the network changed: what failed on the old one is tried again */
		forgetFailures() {
			for (const [key, entry] of known)
				if (entry.verdict === 'failed') known.delete(key);
			void db().then((database) => {
				try {
					const cursor = database
						?.transaction(STORE, 'readwrite')
						.objectStore(STORE)
						.openCursor();
					if (cursor)
						cursor.onsuccess = () => {
							const at = cursor.result;
							if (!at) return;
							if ((at.value as Remembered).verdict === 'failed') at.delete();
							at.continue();
						};
				} catch {
					// storage gone
				}
			});
		},
	};
	try {
		globalThis.addEventListener?.('online', () => api.forgetFailures());
		(
			navigator as Navigator & { connection?: EventTarget }
		).connection?.addEventListener?.('change', () => api.forgetFailures());
	} catch {
		// no events in this realm
	}
	return api;
})();

interface Discovery {
	url: string;
	hashes: { algorithm: string; value: BufferSource }[];
	/** the hashes as the document gave them, to tell a rotation */
	key: string;
}

/** what epoxy's function transport gives back (EpoxyWispTransportResult) */
interface WispPipe {
	read: ReadableStream<ArrayBuffer>;
	write: WritableStream<Uint8Array>;
}

/** the discovery document's URL for a wisp URL (relayPlan's, when it has one) */
export function discoveryURL(wisp: string, options: WispWebTransportOptions) {
	return relayPlan(wisp, options).discovery;
}

function timeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`${what} took longer than ${ms} ms`)),
				ms,
			);
		}),
	]).finally(() => clearTimeout(timer));
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
	const text = atob(value);
	const out = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
	return out;
}

/** a discovery document that could not be had at all (no document to read) */
class NoDocument extends Error {}

async function discover(document: string, ms: number): Promise<Discovery> {
	const controller = new AbortController();
	const response = await timeout(
		fetch(document, {
			cache: 'no-store',
			credentials: 'omit',
			signal: controller.signal,
		}),
		ms,
		'the WebTransport discovery document',
	).catch((error) => {
		controller.abort();
		throw new NoDocument(String(error));
	});
	if (!response.ok)
		throw new NoDocument(`the discovery document answered ${response.status}`);
	const body = (await timeout(response.json(), ms, 'its body').catch(
		(error) => {
			throw new NoDocument(String(error));
		},
	)) as {
		url?: unknown;
		hashes?: unknown;
	};
	const listed = Array.isArray(body?.hashes) ? body.hashes : [];
	const hashes = listed
		.filter(
			(hash): hash is { algorithm: string; value: string } =>
				typeof hash?.algorithm === 'string' &&
				typeof hash?.value === 'string' &&
				hash.algorithm.toLowerCase() === 'sha-256',
		)
		.map((hash) => ({
			algorithm: 'sha-256',
			value: fromBase64(hash.value),
		}));
	// a document without `url` names its own origin, never the page's or
	// the wisp URL's: a relay behind Cloudflare takes UDP only on a host of
	// its own, which `discovery` points at
	const origin = new URL(document);
	origin.protocol = 'https:';
	const url =
		typeof body?.url === 'string' && body.url
			? new URL(body.url, document).href
			: `${origin.origin}/`;
	if (new URL(url).protocol !== 'https:')
		throw new Error(`the discovery document names ${url}, not an https: URL`);
	return { url, hashes, key: JSON.stringify(listed) };
}

/** one session's handshake, within `ms` */
async function handshake(
	found: Discovery,
	v2: boolean,
	ms: number,
): Promise<WebTransport> {
	const options: WebTransportOptions & { protocols?: string[] } = {};
	if (found.hashes.length) options.serverCertificateHashes = found.hashes;
	if (v2) options.protocols = [V2_PROTOCOL];
	const session = new WebTransport(found.url, options);
	// the rejection is the caller's (ready's), not an unhandled one
	session.closed.catch(() => {});
	try {
		await timeout(session.ready, ms, 'the WebTransport handshake');
	} catch (error) {
		try {
			session.close();
		} catch {
			// closed already
		}
		throw error;
	}
	return session;
}

/**
 * A session to the relay `plan` names; throws when it cannot be had. A
 * handshake that fails after a document fetches the document again and
 * tries once more when it changed; a missing document falls back to the
 * plan's direct URL, when it has one.
 */
async function openSession(
	plan: RelayPlan,
	v2: boolean,
	ms: number,
): Promise<WebTransport> {
	const direct = () =>
		plan.direct
			? handshake({ url: plan.direct, hashes: [], key: '' }, v2, ms)
			: Promise.reject(new Error('the relay names no WebTransport session'));
	if (!plan.discovery) return direct();
	let found: Discovery;
	try {
		found = await discover(plan.discovery, ms);
	} catch (error) {
		if (error instanceof NoDocument && plan.direct) return direct();
		throw error;
	}
	try {
		return await handshake(found, v2, ms);
	} catch (error) {
		const again = await discover(plan.discovery, ms);
		if (again.key === found.key && again.url === found.url) throw error;
		return handshake(again, v2, ms);
	}
}

/** a packet's stream id (u32 LE after its type) */
const streamOf = (packet: Uint8Array) =>
	packet[1] | (packet[2] << 8) | (packet[3] << 16) | (packet[4] * 2 ** 24);

/**
 * The Wisp packets of a session as epoxy reads and writes them: each read
 * is one packet (an ArrayBuffer), each write one packet.
 */
function pipeOf(
	session: WebTransport,
	stream: WebTransportBidirectionalStream,
) {
	/** the UDP streams open, whose DATA may go as datagrams */
	const udp = new Set<number>();
	let reading: ReadableStreamDefaultController<ArrayBuffer>;
	let ended = false;
	const end = () => {
		if (ended) return;
		ended = true;
		// as a closed WebSocket ends epoxy's read: the multiplexor sees the
		// transport close
		try {
			reading.close();
		} catch {
			// cancelled already
		}
		try {
			session.close();
		} catch {
			// closed already
		}
	};
	const take = (packet: Uint8Array) => {
		if (ended) return;
		if (packet[0] === CLOSE && packet.length >= 5) udp.delete(streamOf(packet));
		reading.enqueue(
			packet.buffer.slice(
				packet.byteOffset,
				packet.byteOffset + packet.byteLength,
			) as ArrayBuffer,
		);
	};
	const read = new ReadableStream<ArrayBuffer>({
		start(controller) {
			reading = controller;
		},
		cancel() {
			end();
		},
	});
	session.closed.then(end, end);

	// the stream: packets after their u32 LE lengths, cut wherever QUIC cut
	void (async () => {
		const reader = stream.readable.getReader();
		let held = new Uint8Array(0);
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				let buffer: Uint8Array = value;
				if (held.length) {
					buffer = new Uint8Array(held.length + value.length);
					buffer.set(held);
					buffer.set(value, held.length);
				}
				let at = 0;
				while (buffer.length - at >= 4) {
					const length =
						buffer[at] |
						(buffer[at + 1] << 8) |
						(buffer[at + 2] << 16) |
						(buffer[at + 3] * 2 ** 24);
					if (buffer.length - at - 4 < length) break;
					take(buffer.subarray(at + 4, at + 4 + length));
					at += 4 + length;
				}
				held = buffer.slice(at);
			}
		} catch {
			// the session or the stream failed
		}
		end();
	})();

	// datagrams: one whole packet each (UDP DATA)
	void (async () => {
		const reader = session.datagrams.readable.getReader();
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				if (value.length >= 5) take(value);
			}
		} catch {
			// the session ended
		}
	})();

	const streamWriter = stream.writable.getWriter();
	const datagramWriter = session.datagrams.writable.getWriter();
	const write = new WritableStream<Uint8Array>({
		async write(packet) {
			const type = packet[0];
			if (packet.length >= 5) {
				const id = streamOf(packet);
				if (type === CONNECT && packet[5] === UDP) udp.add(id);
				else if (type === CLOSE) udp.delete(id);
				else if (
					type === DATA &&
					udp.has(id) &&
					packet.length <= session.datagrams.maxDatagramSize
				) {
					// a datagram the connection drops is lost, as UDP's is
					await datagramWriter.ready;
					datagramWriter.write(packet).catch(() => {});
					return;
				}
			}
			const framed = new Uint8Array(4 + packet.length);
			const n = packet.length;
			framed[0] = n & 0xff;
			framed[1] = (n >>> 8) & 0xff;
			framed[2] = (n >>> 16) & 0xff;
			framed[3] = (n >>> 24) & 0xff;
			framed.set(packet, 4);
			await streamWriter.write(framed);
		},
		close() {
			end();
		},
		abort() {
			end();
		},
	});
	return { read, write };
}

/** a session's Wisp stream, or null when it cannot be opened */
async function wispPipe(session: WebTransport): Promise<WispPipe | null> {
	try {
		return pipeOf(session, await session.createBidirectionalStream());
	} catch {
		try {
			session.close();
		} catch {
			// closed already
		}
		return null;
	}
}

type TransportClass = new (...args: unknown[]) => ProxyTransport;

/**
 * Epoxy over a WebTransport session when the relay offers one and it can be
 * had now without keeping the WebSocket waiting, else epoxy as given (its
 * WebSocket). Until init() chose, and when it chose the WebSocket, `base` is
 * the transport as given.
 */
export class CarrierTransport implements ProxyTransport {
	#Transport: TransportClass;
	#options: unknown[];
	#wisp: string;
	#webTransport: WispWebTransportOptions;
	#base: ProxyTransport;
	#starting: Promise<void> | null = null;
	/** which carrier the wisp connection rides: null before init() chose */
	carrier: 'webtransport' | 'websocket' | null = null;
	/** the session tried beside the WebSocket, settled (for tests and the demo) */
	probed: Promise<boolean> = Promise.resolve(false);

	constructor(
		Transport: TransportClass,
		options: unknown[],
		webTransport: WispWebTransportOptions,
	) {
		this.#Transport = Transport;
		this.#options = options;
		this.#wisp = (options[0] as { wisp: string }).wisp;
		this.#webTransport = webTransport;
		this.#base = new Transport(...options);
	}

	/** the transport in use (serveTransport and webTransportHost look through it) */
	get base(): ProxyTransport {
		return this.#base;
	}

	get ready(): boolean {
		return this.#base.ready;
	}
	set ready(value: boolean) {
		this.#base.ready = value;
	}

	get client(): unknown {
		return (this.#base as { client?: unknown }).client;
	}

	get fieldSupport(): unknown {
		return (this.#base as { fieldSupport?: unknown }).fieldSupport;
	}

	init(): Promise<void> {
		this.#starting ??= this.#start().catch((error) => {
			this.#starting = null;
			throw error;
		});
		return this.#starting;
	}

	async #start() {
		if (this.carrier === null) {
			const session = await this.#choose();
			if (session) {
				const [first, ...rest] = this.#options;
				this.#base = new this.#Transport(
					{ ...(first as object), wisp: this.#pipes(session) },
					...rest,
				);
				this.carrier = 'webtransport';
				console.info(
					`Stomp: wisp over WebTransport to ${relayPlan(this.#wisp, this.#webTransport).key}`,
				);
			} else {
				this.carrier = 'websocket';
				console.info(`Stomp: wisp over its WebSocket (${this.#why})`);
			}
		}
		await this.#base.init();
	}

	/** the session to ride, or null for the WebSocket (see the top of the file) */
	/** why the WebSocket was chosen, for the console */
	#why = '';

	async #choose(): Promise<WebTransport | null> {
		this.#why = 'no WebTransport in this realm';
		if (typeof WebTransport !== 'function') return null;
		const plan = relayPlan(this.#wisp, this.#webTransport);
		const before = await memory.get(plan.key);
		this.#why = `no WebTransport session to ${plan.key} lately`;
		if (before === 'failed') return null;
		const v2 = Boolean((this.#options[0] as { wisp_v2?: boolean }).wisp_v2);
		const attempt = openSession(
			plan,
			v2,
			this.#webTransport.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		).then(
			(session) => {
				memory.set(plan.key, 'worked');
				return session;
			},
			(error) => {
				memory.set(plan.key, 'failed');
				console.warn(
					`Stomp: no WebTransport session to the wisp relay (${plan.key}); its WebSocket for ${FAILED_FOR_MS / 60000} min:`,
					error,
				);
				return null;
			},
		);
		if (before === 'worked') {
			this.#why = `the session to ${plan.key} that worked before failed`;
			return attempt;
		}
		this.#why = `nothing known of ${plan.key} yet: a session is tried beside it`;
		// nothing known: the WebSocket now, the outcome for the next transport
		this.probed = attempt.then((session) => {
			try {
				session?.close();
			} catch {
				// closed already
			}
			return !!session;
		});
		return null;
	}

	/**
	 * Epoxy's function transport: the first wisp connection it asks for is
	 * the session init() opened. Another one means that connection ended,
	 * and the transport that rode it is done (RevivingTransport makes the
	 * next, which chooses its carrier again). A session that ended without a
	 * close of the relay's (UDP lost under it, or a relay that went away)
	 * leaves nothing known: the next start rides the WebSocket at once and
	 * tries a session beside it, which tells the two apart.
	 */
	#pipes(session: WebTransport): (v2: boolean) => Promise<WispPipe> {
		let opened: WebTransport | null = session;
		const key = relayPlan(this.#wisp, this.#webTransport).key;
		session.closed.catch(() => memory.forget(key));
		return async () => {
			const mine = opened;
			opened = null;
			const pipe = mine ? await wispPipe(mine) : null;
			if (!pipe)
				throw new Error(
					`${CARRIER_LOST}: the WebTransport session to the wisp relay ended`,
				);
			return pipe;
		};
	}

	meta(): Promise<void> {
		return (
			(this.#base as { meta?: () => Promise<void> }).meta?.() ??
			Promise.resolve()
		);
	}

	request(
		remote: URL,
		method: string,
		body: BodyInit | null,
		headers: RawHeaders,
		signal: AbortSignal | undefined,
	): Promise<TransferrableResponse> {
		return this.#base.request(remote, method, body, headers, signal);
	}

	connect(...args: Parameters<ProxyTransport['connect']>) {
		return this.#base.connect(...args);
	}
}
