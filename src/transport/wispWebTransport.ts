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
// - `discovery`: a document `{ url, hashes: [{ algorithm, value }] }` (value
//   in base64; the current certificate and the previous one, which a relay
//   with no public name makes itself every 6 days). Every hash goes in one
//   handshake, as Chrome takes a certificate whose hash is any of them; one
//   that fails is tried once more after the document is fetched again (it
//   may have rotated between the two). A document that lists no `url` names
//   its own origin;
// - with neither: a wss: wisp URL dialed as https:, its path kept (a keyed
//   relay needs it), the relay's own host and path, so everything stays on
//   one name; only when that session cannot be had is `/webtransport.json`
//   on the wisp URL's origin asked (on an app's host that path is the app's:
//   a 404 or a page that is not JSON is no document). A ws: wisp URL has no
//   name to take a certificate from, so it asks the document only.
// A document, or its absence, is kept for DOCUMENT_FOR_MS per URL (`memory`).
//
// The carrier is chosen when the transport starts (CarrierTransport.init),
// from what this relay did before (`memory`, kept in IndexedDB across
// reloads):
// - nothing known: the session and the WebSocket are opened together, and
//   the session is taken when its Wisp stream is up within graceFor() of
//   the WebSocket's (half the WebSocket's own time, between GRACE_MIN_MS and
//   GRACE_MAX_MS: a session's Wisp stream is about one round trip behind a
//   WebSocket, which takes three) and its handshake was done within
//   readyGraceFor() of it (a tenth, 50 to 100 ms: the handshake is done as
//   the WebSocket is, and a network that drops UDP costs only this), else
//   the WebSocket; the one not taken is closed, and the outcome is
//   remembered;
// - the session worked: the session, within `timeoutMs`, else the WebSocket;
// - it failed: the WebSocket alone for FAILED_QUIET_MS, then the WebSocket at
//   once with a session tried beside it whose outcome is remembered, so a
//   relay whose UDP came back is had on the next start. A network change
//   (`online`, a connection change) and a session lost under its requests
//   end the quiet at once.
// A transport keeps its carrier: when it ends, its packets' readable ends as
// a closed WebSocket's does, and the next wisp connection epoxy asks for
// fails as a dead one does (CARRIER_LOST), so RevivingTransport builds a new
// transport that chooses again.
//
// Epoxy is handed the carrier as its function transport (`wisp` a function),
// the WebSocket as well, so that the one not taken can be closed and every
// choice timed; the transport as given (epoxy's own WebSocket, by URL) is
// what is left when neither could be opened.
//
// Without `webTransport` there is nothing to choose: CarrierTransport keeps
// the transport as given, on its own WebSocket, opens its wisp connection
// when it starts (epoxy's replace_stream_provider, as warmTransport did) and
// reports it as it reports a choice, so the host always hears what the
// wisp connection rides.
import type {
	ProxyTransport,
	RawHeaders,
	TransferrableResponse,
} from '@mercuryworkshop/proxy-transports';
import { promptSink } from './promptSink';
import { wispNote } from './transportLog';

/** TransportDescriptor.webTransport */
export interface WispWebTransportOptions {
	/**
	 * the session's https: URL, its certificate checked as any site's (no
	 * discovery document)
	 */
	url?: string;
	/**
	 * the relay's discovery document, resolved against the wisp URL (an
	 * absolute one may name another host's); with neither this nor `url`, a
	 * wss: wisp URL is dialed as https: and `/webtransport.json` on its
	 * origin is asked only when that fails
	 */
	discovery?: string;
	/** how long the document and then the session's handshake may take (ms) */
	timeoutMs?: number;
}

export type Carrier = 'webtransport' | 'websocket';

/**
 * What a transport's wisp connection rides, as the controller and the host
 * page see it (StompController.carrier, its `carrier` event)
 */
export interface CarrierInfo {
	carrier: Carrier;
	/** the session's https: URL, or the WebSocket's wss: (ws:) one */
	url: string;
	/** from the transport's start to its wisp connection's first packet (ms) */
	ms: number;
	/** on the WebSocket: why not WebTransport (`off`: the descriptor has no `webTransport`) */
	why?: string;
	/** what the last transport to this relay in this realm rode, when it was the other carrier */
	previous?: Carrier;
	/** a transport to this relay rode the same carrier before in this realm: this one is a reconnect (a revival) */
	reconnected?: boolean;
	/** the transport module, as named by its URL (`epoxy`, `libcurl`) */
	transport?: string;
	/** whether the descriptor turned HTTP/3 on */
	http3?: boolean;
}

/** what CarrierTransport tells of the transport it carries, beside the carrier */
export interface CarrierLabel {
	transport: string;
	http3: boolean;
}

/** the text RevivingTransport takes for a wisp connection that is gone (its DEAD) */
export const CARRIER_LOST = 'WebTransportCarrierLost';

const DEFAULT_TIMEOUT_MS = 2000;
/**
 * How long a relay whose session could not be had is left to the WebSocket
 * alone; after it each start tries a session beside the WebSocket
 */
const FAILED_QUIET_MS = 30 * 1000;
/** how long a failure is remembered at all (the WebSocket first, a session beside it) */
const FAILED_FOR_MS = 7 * 24 * 60 * 60 * 1000;
/** how long a session that worked is gone to again without the WebSocket first */
const WORKED_FOR_MS = 7 * 24 * 60 * 60 * 1000;
/** how long a discovery document, or a URL that has none, is kept */
const DOCUMENT_FOR_MS = 60 * 60 * 1000;
/**
 * How long after the WebSocket's first packet a session's may come and be
 * taken, as a part of the WebSocket's time, and its bounds (ms): GRACE_*
 * when the session's handshake is done by then (its Wisp stream's first
 * packet is a round trip after it), READY_* for the handshake to be done
 * when it is not, which is all a network that drops UDP costs. Measured to
 * wss://holywisp.fracit.al/ from headless Chrome 157 (45 cold starts,
 * docs/webtransport.md): the handshake was done within 10 ms of the
 * WebSocket's first packet in 44 (one 311 ms after), and the Wisp stream's
 * first packet came 29 % (p50), 42 % (p90), 45 % (max) of the WebSocket's
 * time after the WebSocket's. GRACE_MIN_MS is for a relay a few ms away,
 * where scheduling is the round trip: on a loaded machine's loopback a
 * session whose handshake was done came more than 50 ms after the
 * WebSocket (demo-carrier). It costs a network that drops UDP nothing.
 */
const GRACE_PART = 0.5;
const GRACE_MIN_MS = 150;
const GRACE_MAX_MS = 400;
const READY_PART = 0.1;
const READY_MIN_MS = 50;
const READY_MAX_MS = 100;
/** the protocol offered for Wisp v2 (holyWisp takes any; its own client offers this) */
const V2_PROTOCOL = 'wisp-v2';

const DATA = 0x02;
const CONNECT = 0x01;
const CLOSE = 0x04;
const UDP = 0x02;

const part = (ms: number, of: number, min: number, max: number) =>
	Math.round(Math.min(max, Math.max(min, ms * of)));
/** the wait for a session after the WebSocket was up `wsMs` after the start */
export const graceFor = (wsMs: number) =>
	part(wsMs, GRACE_PART, GRACE_MIN_MS, GRACE_MAX_MS);
/** the wait for its handshake, of that, when it was not done yet */
export const readyGraceFor = (wsMs: number) =>
	part(wsMs, READY_PART, READY_MIN_MS, READY_MAX_MS);

/** where a relay's session is looked for, and what it is remembered by */
export interface RelayPlan {
	key: string;
	discovery?: string;
	direct?: string;
	/** `direct` first, the document only when it fails (no option named either) */
	derived?: boolean;
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
		...(secure && { direct: url.href, derived: true }),
	};
}

type Verdict = 'worked' | 'failed';
interface Remembered {
	verdict: Verdict;
	until: number;
	/** a failure: until when nothing is tried beside the WebSocket */
	quiet?: number;
	/** a failure: what went wrong, for the console and the host */
	reason?: string;
	/** a session that worked: whether by the derived URL or by the document */
	via?: Via;
}
/** how a derived plan's session was had */
type Via = 'direct' | 'document';
/** what memory.get answers: `quiet` the WebSocket alone, `retry` a session beside it */
export type Known = 'worked' | 'quiet' | 'retry';

/** a discovery document as fetched (null: none at that URL), kept by URL */
interface KeptDocument {
	document: { url?: unknown; hashes?: unknown } | null;
	until: number;
}

/**
 * What each relay's session did, by RelayPlan.key, and the discovery
 * documents fetched, by URL: in this realm, and in IndexedDB for the next
 * page or worker of this origin. Storage that cannot be had (a private
 * window's, a sandbox's) only loses the second.
 */
export const memory = (() => {
	const known = new Map<string, Remembered>();
	const documents = new Map<string, KeptDocument>();
	const STORE = 'relays';
	const DOCUMENT = 'document ';
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
	const live = (entry: Remembered | undefined): Known | undefined => {
		const now = Date.now();
		if (!entry || entry.until <= now) return undefined;
		if (entry.verdict === 'worked') return 'worked';
		return (entry.quiet ?? entry.until) > now ? 'quiet' : 'retry';
	};
	const put = (key: string, entry: Remembered) => {
		known.set(key, entry);
		void run('readwrite', (store) => store.put(entry, key));
	};
	const api = {
		async get(key: string): Promise<Known | undefined> {
			if (known.has(key)) return live(known.get(key));
			const stored = (await run('readonly', (store) => store.get(key))) as
				Remembered | undefined;
			if (stored && !known.has(key)) known.set(key, stored);
			return live(known.get(key));
		},
		/** a failure's quiet: when it failed and until when nothing is tried beside the WebSocket */
		quiet(key: string): { failed: number; until: number } | undefined {
			const entry = known.get(key);
			if (entry?.verdict !== 'failed' || entry.quiet === undefined) return;
			return { failed: entry.quiet - FAILED_QUIET_MS, until: entry.quiet };
		},
		/** why the relay's session failed last, when it did */
		reason(key: string): string | undefined {
			const entry = known.get(key);
			return entry?.verdict === 'failed' ? entry.reason : undefined;
		},
		/** how the session that worked was had */
		via(key: string): Via | undefined {
			const entry = known.get(key);
			return entry?.verdict === 'worked' ? entry.via : undefined;
		},
		worked(key: string, via: Via) {
			put(key, { verdict: 'worked', until: Date.now() + WORKED_FOR_MS, via });
		},
		/** the session could not be had: the WebSocket alone for a while */
		failed(key: string, reason: string) {
			const now = Date.now();
			put(key, {
				verdict: 'failed',
				until: now + FAILED_FOR_MS,
				quiet: now + FAILED_QUIET_MS,
				reason,
			});
		},
		/**
		 * a session ended under its requests without a close (UDP lost
		 * under it, a relay gone): the next start rides the WebSocket at once
		 * and tries a session beside it, which tells the two apart
		 */
		lost(key: string) {
			const now = Date.now();
			put(key, {
				verdict: 'failed',
				until: now + FAILED_FOR_MS,
				quiet: now,
				reason: 'the last session ended without a close',
			});
		},
		/** the network changed: what failed on the old one is tried beside the WebSocket */
		forgetFailures() {
			for (const [key, entry] of known)
				if (entry.verdict === 'failed') known.set(key, { ...entry, quiet: 0 });
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
							const entry = at.value as Remembered;
							if (entry.verdict === 'failed') at.update({ ...entry, quiet: 0 });
							at.continue();
						};
				} catch {
					// storage gone
				}
			});
		},
		/** the document kept for `url`: undefined when none is, null when it has none */
		async document(url: string): Promise<KeptDocument['document'] | undefined> {
			let kept = documents.get(url);
			if (!kept) {
				kept = (await run('readonly', (store) => store.get(DOCUMENT + url))) as
					KeptDocument | undefined;
				if (kept && !documents.has(url)) documents.set(url, kept);
			}
			return kept && kept.until > Date.now() ? kept.document : undefined;
		},
		keepDocument(url: string, document: KeptDocument['document']) {
			const kept = { document, until: Date.now() + DOCUMENT_FOR_MS };
			documents.set(url, kept);
			void run('readwrite', (store) => store.put(kept, DOCUMENT + url));
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

/** who hears each choice in this realm (the controller, the transport worker) */
const watchers = new Set<(info: CarrierInfo) => void>();

/** `listener` hears every choice a transport of this realm makes; returns the unwatch */
export function watchCarrier(listener: (info: CarrierInfo) => void) {
	watchers.add(listener);
	return () => void watchers.delete(listener);
}

/** what the last transport to each relay rode in this realm, by RelayPlan.key */
const lastCarrier = new Map<string, Carrier>();

/** a carrier as the notes name it, and what it rides */
const NAME: Record<Carrier, string> = {
	webtransport: 'WebTransport',
	websocket: 'WebSocket',
};
const LABEL: Record<Carrier, string> = {
	webtransport: 'WebTransport (UDP/QUIC)',
	websocket: 'WebSocket (TCP)',
};
/** the error of a relay that names no session at all: an info note, as no relay is no failure */
const NO_SESSION = 'the relay names no WebTransport session';

/** by RelayPlan.key, the quiet a note told already (KrunkNative's skip_noted): one note per backoff */
const quietNoted = new Map<string, number>();

/** the note of a session that could not be had, as KrunkNative words a transport that failed */
function unavailable(key: string, error: unknown, next: string) {
	const why = short(error);
	quietNoted.set(key, memory.quiet(key)?.until ?? 0);
	if (why === NO_SESSION) wispNote('info', `${why}: wisp uses the WebSocket`);
	else
		wispNote(
			'warn',
			`WebTransport unavailable (${why})${next}; WebTransport again in ${FAILED_QUIET_MS / 1000} s`,
		);
}

/**
 * A choice, to the watchers: the host's controller prints it
 * (src/controller/transportConsole.ts), so it is on the host's console
 * whether the transport runs in the worker or in a page
 */
function announce(key: string, info: CarrierInfo) {
	const previous = lastCarrier.get(key);
	lastCarrier.set(key, info.carrier);
	if (previous && previous !== info.carrier) {
		info.previous = previous;
		wispNote(
			'info',
			`switched from ${NAME[previous]} to ${NAME[info.carrier]}`,
		);
	} else if (previous) info.reconnected = true;
	for (const watcher of watchers)
		try {
			watcher(info);
		} catch {
			// a watcher's own error
		}
}

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

/** a carrier that is open, its first Wisp packet read (buffered for epoxy) */
interface OpenCarrier {
	carrier: Carrier;
	url: string;
	pipe: WispPipe;
	/** closes it, as the one not taken */
	close(): void;
	/** settles when it ends; rejects when it ended without a close of the relay's */
	ended: Promise<void>;
	/** the WebSocket's: settles with its close code once it closed */
	closed?: Promise<number>;
	/** the Wisp packets it carried each way, and of them as datagrams (the session's) */
	stats?: PipeStats;
}

/** what a session carried, for the note when it ends */
interface PipeStats {
	sent: number;
	received: number;
	datagramsSent: number;
	datagramsReceived: number;
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

const short = (error: unknown) =>
	String((error as Error)?.message ?? error).slice(0, 160);

/** the document at `url` as fetched, null when there is none (an error, not ok, not JSON) */
async function fetchDocument(
	url: string,
	ms: number,
): Promise<KeptDocument['document']> {
	const controller = new AbortController();
	try {
		const response = await timeout(
			fetch(url, {
				cache: 'no-store',
				credentials: 'omit',
				signal: controller.signal,
			}),
			ms,
			'the WebTransport discovery document',
		);
		if (!response.ok) return null;
		// an app's page at that path (a 200 with HTML) is no document
		const body = (await timeout(response.json(), ms, 'its body')) as unknown;
		return body && typeof body === 'object'
			? (body as { url?: unknown; hashes?: unknown })
			: null;
	} catch {
		controller.abort();
		return null;
	}
}

/** a document fetched: what the session is */
function readDocument(
	url: string,
	body: NonNullable<KeptDocument['document']>,
): Discovery {
	const listed = Array.isArray(body.hashes) ? body.hashes : [];
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
	const origin = new URL(url);
	origin.protocol = 'https:';
	const session =
		typeof body.url === 'string' && body.url
			? new URL(body.url, url).href
			: `${origin.origin}/`;
	if (new URL(session).protocol !== 'https:')
		throw new Error(
			`the discovery document names ${session}, not an https: URL`,
		);
	return { url: session, hashes, key: JSON.stringify(listed) };
}

/**
 * The document at `url`, the kept one when there is one (`fresh`: fetched
 * now, and kept); null when there is none
 */
async function discover(
	url: string,
	ms: number,
	fresh = false,
): Promise<{ found: Discovery | null; kept: boolean }> {
	let body = fresh ? undefined : await memory.document(url);
	const kept = body !== undefined;
	if (body === undefined) {
		body = await fetchDocument(url, ms);
		memory.keepDocument(url, body);
	}
	return { found: body ? readDocument(url, body) : null, kept };
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

interface Opened {
	session: WebTransport;
	url: string;
	via: Via;
}

/**
 * A session to the relay `plan` names, and its URL; throws when it cannot be
 * had. A derived plan dials the wisp URL's own host and path first and asks
 * the document only when that fails (or first, when a session had by the
 * document is remembered: `prefer`); a handshake that fails after a
 * document fetches the document again and tries once more when it changed.
 */
async function openSession(
	plan: RelayPlan,
	v2: boolean,
	ms: number,
	prefer?: Via,
): Promise<Opened> {
	const direct = async (url: string): Promise<Opened> => ({
		session: await handshake({ url, hashes: [], key: '' }, v2, ms),
		url,
		via: 'direct',
	});
	let first: unknown = null;
	if (plan.direct) {
		if (!plan.discovery) return direct(plan.direct);
		if (plan.derived && prefer !== 'document')
			try {
				return await direct(plan.direct);
			} catch (error) {
				first = error;
			}
	}
	const { found } = await discover(plan.discovery!, ms);
	if (!found) throw first ?? new Error(NO_SESSION);
	// the document names the session that failed already
	if (first && found.url === plan.direct && !found.hashes.length) throw first;
	const by = async (found: Discovery): Promise<Opened> => ({
		session: await handshake(found, v2, ms),
		url: found.url,
		via: 'document',
	});
	try {
		return await by(found);
	} catch (error) {
		// it may have rotated since it was fetched (or kept)
		const again = (await discover(plan.discovery!, ms, true)).found;
		if (!again || (again.key === found.key && again.url === found.url))
			throw error;
		return by(again);
	}
}

/** the u32 LE at `at` */
const u32 = (bytes: Uint8Array, at: number) =>
	bytes[at] |
	(bytes[at + 1] << 8) |
	(bytes[at + 2] << 16) |
	(bytes[at + 3] * 2 ** 24);
/** a packet's stream id (u32 LE after its type) */
const streamOf = (packet: Uint8Array) => u32(packet, 1);

/** a promise that settles when its `settle` is called, and when the first packet was read */
function firstPacket() {
	let got!: () => void;
	let failed!: (error: unknown) => void;
	const first = new Promise<void>((resolve, reject) => {
		got = resolve;
		failed = reject;
	});
	first.catch(() => {});
	return { first, got, failed };
}

/**
 * The Wisp packets of a session as epoxy reads and writes them: each read
 * is one packet (an ArrayBuffer), each write one packet. `first` settles
 * with the first packet the relay sends (read and kept for epoxy).
 */
function pipeOf(
	session: WebTransport,
	stream: WebTransportBidirectionalStream,
) {
	/** the UDP streams open, whose DATA may go as datagrams */
	const udp = new Set<number>();
	let reading: ReadableStreamDefaultController<ArrayBuffer>;
	let ended = false;
	const { first, got, failed } = firstPacket();
	const stats: PipeStats = {
		sent: 0,
		received: 0,
		datagramsSent: 0,
		datagramsReceived: 0,
	};
	const end = () => {
		if (ended) return;
		ended = true;
		failed(new Error('the WebTransport session ended before the relay spoke'));
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
	/** a packet, in a buffer of its own (handed to epoxy as it is) */
	const take = (packet: Uint8Array<ArrayBuffer>) => {
		if (ended) return;
		if (packet[0] === CLOSE && packet.length >= 5) udp.delete(streamOf(packet));
		stats.received++;
		reading.enqueue(packet.buffer);
		got();
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

	// the stream: packets after their u32 LE lengths, cut wherever QUIC cut.
	// Each byte is copied once, into its packet's own buffer, however many
	// chunks the packet spans: a relay's DATA packet is up to 128 KiB and a
	// reader that keeps up gets a chunk of a few QUIC packets, so gathering
	// the chunks into one buffer that grew with each copied the packet over
	// again for every chunk of it.
	void (async () => {
		const reader = stream.readable.getReader();
		/** a prefix cut between chunks */
		const prefix = new Uint8Array(4);
		let prefixed = 0;
		/** the packet being filled, when it spans chunks */
		let packet: Uint8Array<ArrayBuffer> | null = null;
		let filled = 0;
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				let at = 0;
				while (at < value.length) {
					if (!packet) {
						let length: number;
						if (!prefixed && value.length - at >= 4) {
							length = u32(value, at);
							at += 4;
						} else {
							const n = Math.min(4 - prefixed, value.length - at);
							prefix.set(value.subarray(at, at + n), prefixed);
							prefixed += n;
							at += n;
							if (prefixed < 4) break;
							prefixed = 0;
							length = u32(prefix, 0);
						}
						if (value.length - at >= length) {
							take(value.slice(at, at + length));
							at += length;
							continue;
						}
						packet = new Uint8Array(length);
						filled = 0;
					}
					const n = Math.min(packet.length - filled, value.length - at);
					packet.set(value.subarray(at, at + n), filled);
					filled += n;
					at += n;
					if (filled === packet.length) {
						take(packet);
						packet = null;
					}
				}
			}
		} catch {
			// the session or the stream failed
		}
		end();
	})();

	// datagrams: one whole packet each (UDP DATA), each a chunk of its own
	void (async () => {
		const reader = session.datagrams.readable.getReader();
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				if (value.length < 5) continue;
				stats.datagramsReceived++;
				take(
					value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
						? (value as Uint8Array<ArrayBuffer>)
						: value.slice(),
				);
			}
		} catch {
			// the session ended
		}
	})();

	const streamWriter = stream.writable.getWriter();
	const datagramWriter = session.datagrams.writable.getWriter();
	const write = new WritableStream<Uint8Array>({
		async write(packet) {
			stats.sent++;
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
					stats.datagramsSent++;
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
	return { pipe: { read, write }, first, stats };
}

/**
 * A session's Wisp stream, open once the relay sent its first packet
 * (within `ms`); throws when it cannot be had, the session closed
 */
async function sessionCarrier(
	plan: RelayPlan,
	v2: boolean,
	ms: number,
	/** called when the handshake is done, before the Wisp stream is up */
	handshaken?: () => void,
): Promise<OpenCarrier & { via: Via }> {
	const { session, url, via } = await openSession(
		plan,
		v2,
		ms,
		memory.via(plan.key),
	);
	handshaken?.();
	const close = () => {
		try {
			session.close();
		} catch {
			// closed already
		}
	};
	try {
		const { pipe, first, stats } = pipeOf(
			session,
			await session.createBidirectionalStream(),
		);
		await timeout(first, ms, 'the Wisp stream');
		const ended = session.closed.then(() => {});
		ended.catch(() => {});
		return { carrier: 'webtransport', url, via, pipe, close, ended, stats };
	} catch (error) {
		close();
		throw error;
	}
}

/**
 * The wisp WebSocket as epoxy's own would open it (its protocols, one more
 * asking for v2), open once the relay sent its first packet (within `ms`).
 * Its messages are packets as they come, kept for epoxy; a write is a send,
 * which never waits, as epoxy's own.
 */
function socketCarrier(
	url: string,
	protocols: string[],
	ms: number,
): Promise<OpenCarrier> {
	return new Promise((resolve, reject) => {
		let socket: WebSocket;
		try {
			socket = protocols.length
				? new WebSocket(url, protocols)
				: new WebSocket(url);
		} catch (error) {
			reject(error);
			return;
		}
		socket.binaryType = 'arraybuffer';
		let reading: ReadableStreamDefaultController<ArrayBuffer>;
		let spoke = false;
		let ended = false;
		let endedBy: () => void;
		const done = new Promise<void>((resolve) => (endedBy = resolve));
		let closedWith!: (code: number) => void;
		const closed = new Promise<number>((resolve) => (closedWith = resolve));
		const close = () => {
			try {
				socket.close(1000);
			} catch {
				// closed already
			}
		};
		const timer = setTimeout(() => {
			close();
			reject(new Error(`the wisp WebSocket took longer than ${ms} ms`));
		}, ms);
		const end = () => {
			if (ended) return;
			ended = true;
			clearTimeout(timer);
			if (!spoke)
				reject(new Error('the wisp WebSocket closed before the relay spoke'));
			try {
				reading.close();
			} catch {
				// cancelled already
			}
			endedBy();
		};
		const read = new ReadableStream<ArrayBuffer>({
			start(controller) {
				reading = controller;
			},
			cancel() {
				close();
			},
		});
		socket.onmessage = (event) => {
			if (ended || !(event.data instanceof ArrayBuffer)) return;
			reading.enqueue(event.data);
			if (spoke) return;
			spoke = true;
			clearTimeout(timer);
			resolve({
				carrier: 'websocket',
				url,
				pipe: {
					read,
					write: new WritableStream<Uint8Array>({
						write(packet) {
							if (socket.readyState === WebSocket.OPEN) socket.send(packet);
						},
						close,
						abort: close,
					}),
				},
				close,
				ended: done,
				closed,
			});
		};
		socket.onclose = (event) => {
			closedWith(event.code);
			end();
		};
		socket.onerror = end;
	});
}

type TransportClass = new (...args: unknown[]) => ProxyTransport;

/**
 * Epoxy over the relay's WebTransport session or its WebSocket, whichever
 * init() chose (see the top of the file). Until init() chose, and when
 * neither could be opened, `base` is the transport as given.
 */
export class CarrierTransport implements ProxyTransport {
	#Transport: TransportClass;
	#options: unknown[];
	#wisp: string;
	/** null: off, the transport as given on its own WebSocket */
	#webTransport: WispWebTransportOptions | null;
	#label: CarrierLabel | null;
	#base: ProxyTransport;
	#starting: Promise<void> | null = null;
	/** which carrier the wisp connection rides: null before init() chose */
	carrier: Carrier | null = null;
	/** the choice, as the console and the host have it */
	info: CarrierInfo | null = null;
	/** the session tried beside the WebSocket, settled (for tests and the demo) */
	probed: Promise<boolean> = Promise.resolve(false);

	constructor(
		Transport: TransportClass,
		options: unknown[],
		webTransport: WispWebTransportOptions | null,
		label: CarrierLabel | null = null,
	) {
		this.#Transport = Transport;
		this.#options = options;
		this.#wisp = (options[0] as { wisp: string }).wisp;
		this.#webTransport = webTransport;
		this.#label = label;
		this.#base = new Transport(...options);
	}

	/**
	 * whether init() opens the wisp connection itself (no `webTransport`):
	 * warmTransport must not open another
	 */
	get opensWisp(): boolean {
		return !this.#webTransport;
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

	get #v2(): boolean {
		return Boolean((this.#options[0] as { wisp_v2?: boolean }).wisp_v2);
	}

	get #timeoutMs(): number {
		return this.#webTransport?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/** the choice, told: the host's `carrier` */
	#announce(key: string, info: CarrierInfo) {
		this.info = { ...info, ...this.#label };
		announce(key, this.info);
	}

	/** what the notes say of the transport beside its carrier: `epoxy, HTTP/3 on` */
	get #what(): string {
		const label = this.#label;
		return label
			? `${label.transport}, HTTP/3 ${label.http3 ? 'on' : 'off'}`
			: '';
	}

	/** the note of riding the WebSocket */
	#connecting(off = false) {
		const what = this.#what;
		wispNote(
			'info',
			`connecting to ${this.#wisp} (wisp transport ${LABEL.websocket}${off ? ', WebTransport off' : ''}${what ? `; ${what}` : ''})`,
		);
	}

	/**
	 * No `webTransport`: the transport as given, on its own WebSocket. Its
	 * wisp connection is opened now and the time to it told (epoxy's
	 * replace_stream_provider settles once the relay answered; a request
	 * meanwhile waits for that connection, as warmTransport had it); a
	 * transport without that call is timed to the end of its init. A
	 * connection that cannot be opened now is left to the first request,
	 * as before, and the line says why.
	 */
	async #plain() {
		const key = `wisp ${this.#wisp}`;
		this.#connecting(true);
		let started = performance.now();
		await this.#base.init();
		this.carrier = 'websocket';
		const client = (
			this.#base as {
				client?: { replace_stream_provider?: () => Promise<unknown> };
			}
		).client;
		if (typeof client?.replace_stream_provider !== 'function') {
			const ms = Math.round(performance.now() - started);
			this.#announce(key, {
				carrier: 'websocket',
				url: this.#wisp,
				ms,
				why: 'off',
			});
			return;
		}
		started = performance.now();
		client.replace_stream_provider().then(
			() => {
				const ms = Math.round(performance.now() - started);
				this.#announce(key, {
					carrier: 'websocket',
					url: this.#wisp,
					ms,
					why: 'off',
				});
			},
			(error) => {
				const ms = Math.round(performance.now() - started);
				wispNote(
					'warn',
					`websocket did not open (${short(error)}); the first request tries again`,
				);
				this.#announce(key, {
					carrier: 'websocket',
					url: this.#wisp,
					ms,
					why: `off; the WebSocket did not open (${short(error)})`,
				});
			},
		);
	}

	async #start() {
		if (this.carrier === null) {
			if (!this.#webTransport) return this.#plain();
			const plan = relayPlan(this.#wisp, this.#webTransport);
			const started = performance.now();
			const { open, why } = await this.#choose(plan);
			const ms = Math.round(performance.now() - started);
			if (open) {
				const [first, ...rest] = this.#options;
				this.#base = new this.#Transport(
					{ ...(first as object), wisp: this.#pipes(open, plan.key) },
					...rest,
				);
			}
			this.carrier = open?.carrier ?? 'websocket';
			if (this.carrier === 'webtransport') {
				const what = this.#what;
				wispNote(
					'info',
					`WebTransport session established in ${ms} ms: wisp transport ${LABEL.webtransport} to ${open!.url}${what ? ` (${what})` : ''}`,
				);
			} else this.#connecting();
			this.#announce(plan.key, {
				carrier: this.carrier,
				url: open?.url ?? this.#wisp,
				ms,
				...(this.carrier === 'websocket' && { why }),
			});
		}
		await this.#base.init();
	}

	/** the WebSocket, opened as epoxy's own would be */
	#socket(): Promise<OpenCarrier> {
		const first = this.#options[0] as { wisp_ws_protocols?: string[] };
		const protocols = [...(first.wisp_ws_protocols ?? [])];
		// epoxy asks for v2 with a protocol of its own; holyWisp takes any
		if (this.#v2) protocols.push(crypto.randomUUID());
		return socketCarrier(
			this.#wisp,
			protocols,
			Math.max(10000, this.#timeoutMs),
		);
	}

	/** a session, remembered as working or failing */
	#session(plan: RelayPlan, handshaken?: () => void): Promise<OpenCarrier> {
		return sessionCarrier(plan, this.#v2, this.#timeoutMs, handshaken).then(
			(open) => {
				memory.worked(plan.key, open.via);
				return open;
			},
			(error) => {
				memory.failed(plan.key, short(error));
				throw error;
			},
		);
	}

	/**
	 * The carrier to ride (null: neither could be opened, the transport as
	 * given), and why it is not the session when it is not
	 */
	async #choose(
		plan: RelayPlan,
	): Promise<{ open: OpenCarrier | null; why: string }> {
		const socket = () =>
			this.#socket().catch((error) => {
				wispNote('warn', `websocket did not open (${short(error)})`);
				return null;
			});
		const target = plan.direct ?? plan.discovery;
		if (typeof WebTransport !== 'function') {
			wispNote(
				'info',
				'WebTransport unavailable (none in this realm): wisp uses the WebSocket',
			);
			return { open: await socket(), why: 'none in this realm' };
		}
		const before = await memory.get(plan.key);
		if (before === 'quiet') {
			const reason = memory.reason(plan.key) ?? 'no session';
			const quiet = memory.quiet(plan.key);
			if (quiet && quietNoted.get(plan.key) !== quiet.until) {
				quietNoted.set(plan.key, quiet.until);
				const now = Date.now();
				wispNote(
					'info',
					`WebTransport skipped: it failed ${Math.round((now - quiet.failed) / 1000)} s ago (${reason}); next try in ${Math.max(0, Math.round((quiet.until - now) / 1000))} s`,
				);
			}
			return {
				open: await socket(),
				why: `it failed lately (${reason}); tried again within ${FAILED_QUIET_MS / 1000} s`,
			};
		}
		if (before === 'worked') {
			wispNote('info', `trying the WebTransport transport to ${target}`);
			try {
				return { open: await this.#session(plan), why: '' };
			} catch (error) {
				unavailable(plan.key, error, ', trying the next transport');
				return {
					open: await socket(),
					why: `the session that worked before failed: ${short(error)}`,
				};
			}
		}
		if (before === 'retry') {
			// the WebSocket now; the session's outcome for the next transport
			const reason = memory.reason(plan.key) ?? 'no session';
			wispNote(
				'info',
				`trying the WebTransport transport to ${target} beside the WebSocket, for the next start`,
			);
			const started = performance.now();
			this.probed = this.#session(plan).then(
				(open) => {
					open.close();
					wispNote(
						'info',
						`WebTransport session established in ${Math.round(performance.now() - started)} ms beside the WebSocket: the next start takes it`,
					);
					return true;
				},
				(error) => {
					unavailable(plan.key, error, '');
					return false;
				},
			);
			return {
				open: await socket(),
				why: `it failed before (${reason}); a session is tried beside the WebSocket`,
			};
		}
		wispNote(
			'info',
			`trying the WebTransport transport to ${target}, the WebSocket beside it`,
		);
		return this.#race(plan, socket);
	}

	/**
	 * Nothing known: the session and the WebSocket together, the session
	 * taken when its Wisp stream is up within graceFor() of the
	 * WebSocket's, and its handshake done within readyGraceFor(); the other
	 * is closed
	 */
	async #race(
		plan: RelayPlan,
		openSocket: () => Promise<OpenCarrier | null>,
	): Promise<{ open: OpenCarrier | null; why: string }> {
		const started = performance.now();
		let handshaken!: () => void;
		const handshake = new Promise<'handshaken'>(
			(resolve) => (handshaken = () => resolve('handshaken')),
		);
		let isHandshaken = false;
		void handshake.then(() => (isHandshaken = true));
		const session = this.#session(plan, handshaken);
		session.catch(() => {});
		const socket = openSocket();
		let sessionError: unknown = null;
		type Won = { open: OpenCarrier | null; from: 'session' | 'socket' };
		const bySession: Promise<Won | null> = session.then(
			(open) => ({ open, from: 'session' }),
			(error) => {
				sessionError = error;
				return null;
			},
		);
		const bySocket: Promise<Won> = socket.then((open) => ({
			open,
			from: 'socket',
		}));
		const first = await Promise.race([
			bySession.then((won) => won ?? bySocket),
			bySocket,
		]);
		// the one not taken is closed when it opens
		const loser = (other: Promise<OpenCarrier | null>) =>
			void other.then(
				(open) => open?.close(),
				() => {},
			);
		this.probed = session.then(
			() => true,
			() => false,
		);
		if (first.from === 'session') {
			loser(socket);
			return { open: first.open, why: '' };
		}
		if (!first.open) {
			// no WebSocket: the session when it comes
			const open = await session.catch(() => null);
			if (!open)
				unavailable(plan.key, sessionError, ', and the WebSocket neither');
			return {
				open,
				why: `no session either: ${short(sessionError)}`,
			};
		}
		const wsMs = performance.now() - started;
		const grace = graceFor(wsMs);
		const readyGrace = readyGraceFor(wsMs);
		const after = (ms: number) =>
			new Promise<'late'>((resolve) => setTimeout(() => resolve('late'), ms));
		const deadline = performance.now() + grace;
		// its handshake first, when it is not done: a network that drops UDP
		// costs this much
		const handshakeLate =
			!isHandshaken &&
			(await Promise.race([handshake, bySession, after(readyGrace)])) ===
				'late';
		const late = handshakeLate
			? 'late'
			: await Promise.race([
					bySession,
					after(Math.max(0, deadline - performance.now())),
				]);
		if (late && late !== 'late') {
			loser(socket);
			return { open: late.open, why: '' };
		}
		loser(session);
		if (late === 'late')
			wispNote(
				'info',
				`WebTransport unavailable (${handshakeLate ? `no handshake within ${readyGrace} ms` : `not up within ${grace} ms`} of the WebSocket), trying the next transport; WebTransport again on the next start if it comes up`,
			);
		else unavailable(plan.key, sessionError, ', trying the next transport');
		return {
			open: first.open,
			why:
				late === 'late'
					? handshakeLate
						? `no handshake within ${readyGrace} ms of the WebSocket (remembered for the next start)`
						: `not up within ${grace} ms of the WebSocket (remembered for the next start)`
					: short(sessionError),
		};
	}

	/**
	 * Epoxy's function transport: the first wisp connection it asks for is
	 * the carrier init() opened. Another one means that connection ended,
	 * and the transport that rode it is done (RevivingTransport makes the
	 * next, which chooses its carrier again). A session that ended without a
	 * close of the relay's (UDP lost under it, or a relay that went away)
	 * is remembered as lost: the next start rides the WebSocket at once and
	 * tries a session beside it, which tells the two apart.
	 */
	#pipes(open: OpenCarrier, key: string): (v2: boolean) => Promise<WispPipe> {
		let unused: OpenCarrier | null = open;
		const up = performance.now();
		const stats = open.stats;
		const ended = (how: string) =>
			`WebTransport session ended after ${Math.round((performance.now() - up) / 1000)} s (${how}${stats ? `; sent ${stats.datagramsSent} / received ${stats.datagramsReceived} datagrams, ${stats.sent - stats.datagramsSent} / ${stats.received - stats.datagramsReceived} packets on the stream` : ''})`;
		if (open.carrier === 'webtransport')
			open.ended.then(
				() => wispNote('info', ended('closed')),
				() => {
					memory.lost(key);
					wispNote('warn', ended('lost without a close'));
				},
			);
		else
			void open.closed?.then((code) =>
				wispNote(
					code === 1000 ? 'info' : 'warn',
					`websocket closed (code ${code})`,
				),
			);
		return async () => {
			const mine = unused;
			unused = null;
			if (!mine)
				throw new Error(
					`${CARRIER_LOST}: the ${open.carrier === 'webtransport' ? 'WebTransport session' : 'WebSocket'} to the wisp relay ended`,
				);
			return { read: mine.pipe.read, write: promptSink(mine.pipe.write) };
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
