// Wisp over WebTransport (holyWisp's WebTransport listener, its
// docs/webtransport.md, "Wisp on the session"): the same Wisp packets a
// WebSocket would carry, on a bidirectional stream of a WebTransport
// session, each after its length as a u32 LE; and a UDP stream's DATA, when
// it fits, as one QUIC datagram (no prefix), so a lost datagram of a QUIC or
// WebRTC flow inside is lost rather than holding up every other stream.
// Two extensions (~/.claude/stomp-work/wisp-lanes/SPEC.md; docs/
// webtransport.md, "Wisp over WebTransport"), each only with a relay that
// has it: the relay opens that stream itself in the flight of its answer
// (`wisp-v2-server-stream`), and a relay whose INFO offers lanes (0xE1)
// takes more streams, each Wisp stream riding the lane its CONNECT went on
// (pipeOf).
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
// - nothing known: UDP first. The session is the carrier when its Wisp
//   stream is up within firstStartMs() of the start (each of its steps
//   within `timeoutMs`), however long after the WebSocket that is; the
//   WebSocket, opened beside it as a standby, is ridden only when the
//   session failed (at once, without waiting out the time) or is not up by
//   then. Past that time, whichever is up first; the one not taken is
//   closed, and the session's outcome is remembered (a session up too late
//   for this start is the next start's). A network that drops UDP pays its
//   handshake's `timeoutMs` once per relay;
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
import { closeOnDelete, storeName } from '../profile';
import { askCarrierHost, type CarrierGiven } from './carrierClient';
import { promptSink } from './promptSink';
import type { Ride } from './riderPace';
import { wispNote } from './transportLog';
import {
	clean,
	originOf,
	startTrace,
	type StageTrace,
} from './webTransportTrace';

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
	/**
	 * how long the document, the session's handshake and its Wisp stream may
	 * each take (ms); on a start that knows nothing of the relay, the session
	 * may take half as long again in all before the WebSocket is ridden
	 */
	timeoutMs?: number;
	/**
	 * the most QUIC streams ("lanes", lane 0 counted) the session's Wisp
	 * rides when the relay offers them: each has Chrome's 6 MiB window, and
	 * a lost packet holds up only its own. The relay's number when unset;
	 * 1 for one stream
	 */
	lanes?: number;
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
	/**
	 * the carrier is the carrier host's, which this origin's transports
	 * share (carrierHost.ts): how long it had been up when this transport
	 * took it, in ms (0: it was opened for this one)
	 */
	shared?: number;
	/** the session's lanes, lane 0 counted (1: one stream, as a relay without them) */
	lanes?: number;
	/** the relay opened the session's Wisp stream (in the flight of its answer) */
	serverStream?: boolean;
}

/** what CarrierTransport tells of the transport it carries, beside the carrier */
export interface CarrierLabel {
	transport: string;
	http3: boolean;
}

/** the text RevivingTransport takes for a wisp connection that is gone (its DEAD) */
export const CARRIER_LOST = 'WebTransportCarrierLost';

/**
 * Each step of a session (the document, the handshake, the Wisp stream);
 * a network that drops UDP pays the handshake's once per relay. On a first
 * start the whole session has FIRST_START_PART of it from the start. The
 * session on https://stomp.fracit.al/ (holyWisp's QUIC listener on the
 * page's own host, 136 ms away through a WireGuard hop that cost each
 * session one server PTO; headless Chrome 157, 12 cold starts, 2026-11-19)
 * had its handshake done in 1029 ms (p50) and 1388 at most, and
 * its Wisp stream's first packet came at 1182 (p50), 1454 (p90) and 1511
 * ms at most, about nine round trips, where the WebSocket's came at 520:
 * 3 s is twice the slowest, so a relay of that shape is had on the first
 * start up to about 300 ms away.
 */
const DEFAULT_TIMEOUT_MS = 2000;
/** how long a wisp WebSocket may take to open and hear the relay (ms) */
const DEFAULT_SOCKET_MS = 10000;
const FIRST_START_PART = 1.5;
/** how long a start that knows nothing of the relay waits for the session */
export const firstStartMs = (timeoutMs: number) =>
	Math.round(timeoutMs * FIRST_START_PART);
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
 * The protocols a session offers, in this order (~/.claude/stomp-work/
 * wisp-lanes/SPEC.md, section 1): Wisp v2, which holyWisp takes with any
 * protocol offered and echoes the first of; and the server-opened Wisp
 * stream, which a relay that has it answers instead, opening lane 0 itself
 * with its INFO and CONTINUE in the flight of its 200
 */
const V2_PROTOCOL = 'wisp-v2';
const SERVER_STREAM_PROTOCOL = 'wisp-v2-server-stream';

const CONNECT = 0x01;
const DATA = 0x02;
const CONTINUE = 0x03;
const CLOSE = 0x04;
const INFO = 0x05;
const UDP = 0x02;
/** the lanes extension in a relay's INFO (u8: the most lanes, lane 0 counted) and the packet that opens a lane */
const LANES_EXTENSION = 0xe1;
const LANE = 0xe1;
/** the reset of a stream the client did not ask for */
const STREAM_UNWANTED = 2;
/** the relay's reset of a lane it does not take (an index past what it takes) */
const LANE_REFUSED = 1;
/**
 * what a lane keeps of what it sent until the relay first answers on it,
 * to send again on another lane if the relay refuses it (bytes); past
 * this a refusal ends the session
 */
const LANE_REPLAY_MAX = 4 * 1024 * 1024;
/** by RelayPlan.key, the lanes a relay took when it refused the next (lane 0 counted): later sessions open no more */
const laneCaps = new Map<string, number>();
/**
 * The lanes a session has at most, lane 0 counted: what the relay offers
 * (holyWisp's webtransport-lanes, 8 by default), within the descriptor's
 * `lanes` and this, so a relay set to 255 does not make it open 254
 */
const MAX_LANES = 16;
/** a lane's recent traffic halves each second; lanes within LANE_QUIET_BYTES of the quietest are as quiet */
const LANE_HALF_LIFE_MS = 1000;
const LANE_QUIET_BYTES = 64 * 1024;

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
				const request = indexedDB.open(storeName('stomp-wisp-carrier'), 1);
				request.onupgradeneeded = () => request.result.createObjectStore(STORE);
				request.onsuccess = () => {
					closeOnDelete(request.result, () => (opened = null));
					resolve(request.result);
				};
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
			// what is stored, every time: the carrier host's realm outlives
			// pages that wrote here too (a transport that chose on its own)
			const stored = (await run('readonly', (store) => store.get(key))) as
				Remembered | undefined;
			if (stored) known.set(key, stored);
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
export interface WispPipe {
	read: ReadableStream<ArrayBuffer>;
	write: WritableStream<Uint8Array>;
	/**
	 * one more wisp connection over the same carrier, as a port another
	 * realm speaks Wisp on (wispSplit.ts lanePipe); null once the carrier is
	 * gone. A carrier host's rider has it (carrierClient.ts `ride`), paced
	 * when `credit` (riderPace.ts)
	 */
	more?: () => Promise<Ride | null>;
}

/** a carrier that is open, its first Wisp packet read (buffered for epoxy) */
export interface OpenCarrier {
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
	/** a wisp connection of the carrier host's (carrierHost.ts), which tells how the carrier ends */
	hosted?: boolean;
	/** WispPipe.more: more riders of the carrier host's relay */
	more?: () => Promise<Ride | null>;
}

/**
 * what the notes say of a session's shape: `8 lanes, the relay opened the
 * Wisp stream` (empty for one lane the client opened)
 */
function shapeOf(lanes: number | undefined, server: boolean | undefined) {
	return [
		lanes && lanes > 1 && `${lanes} lanes`,
		server && 'the relay opened the Wisp stream',
	]
		.filter(Boolean)
		.join(', ');
}

/**
 * The notes of a carrier that ends, and a session lost without a close of
 * the relay's remembered as lost: the next start rides the WebSocket at
 * once and tries a session beside it, which tells the two apart
 */
export function watchEnd(open: OpenCarrier, key: string) {
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
}

/** what a session carried, for the note when it ends */
interface PipeStats {
	sent: number;
	received: number;
	datagramsSent: number;
	datagramsReceived: number;
	/** the lanes, lane 0 counted */
	lanes: number;
	/** the relay opened lane 0 */
	server: boolean;
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
	trace?: StageTrace | null,
): Promise<KeptDocument['document']> {
	const controller = new AbortController();
	const none = (why: string) => {
		trace?.step('carrier', `discovery ${originOf(url)}: no document (${why})`);
		return null;
	};
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
		if (!response.ok) return none(`status ${response.status}`);
		// an app's page at that path (a 200 with HTML) is no document
		const body = (await timeout(response.json(), ms, 'its body')) as unknown;
		return body && typeof body === 'object'
			? (body as { url?: unknown; hashes?: unknown })
			: none('not a JSON object');
	} catch (error) {
		controller.abort();
		return none(short(error));
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
	trace?: StageTrace | null,
): Promise<{ found: Discovery | null; kept: boolean }> {
	let body = fresh ? undefined : await memory.document(url);
	const kept = body !== undefined;
	if (body === undefined) {
		body = await fetchDocument(url, ms, trace);
		memory.keepDocument(url, body);
	} else if (!body)
		trace?.step('carrier', `discovery ${originOf(url)}: none (kept)`);
	const found = body ? readDocument(url, body) : null;
	if (found)
		trace?.step(
			'carrier',
			`discovery ${originOf(url)}${kept ? ' (kept)' : ''}: session ${originOf(found.url)}, ${found.hashes.length} hashes`,
		);
	return { found, kept };
}

/** a session's error as the trace tells it: Chrome's WebTransportError fields */
function errorFields(error: unknown): string {
	const e = error as {
		name?: unknown;
		message?: unknown;
		source?: unknown;
		streamErrorCode?: unknown;
	} | null;
	if (!e || typeof e !== 'object') return clean(error, 160);
	const native =
		typeof WebTransportError === 'function' &&
		error instanceof WebTransportError;
	return clean(
		`${String(e.name ?? 'Error')}: ${String(e.message ?? '')}${native ? ` (source ${String(e.source)}, streamErrorCode ${String(e.streamErrorCode)})` : ''}`,
		160,
	);
}

/** one session's handshake, within `ms` */
async function handshake(
	found: Discovery,
	ms: number,
	trace?: StageTrace | null,
): Promise<WebTransport> {
	const start = performance.now();
	const took = () => Math.round(performance.now() - start);
	const what = `handshake to ${originOf(found.url)} (${found.hashes.length ? `${found.hashes.length} pinned hashes` : 'Web PKI'})`;
	const options: WebTransportOptions & { protocols?: string[] } = {};
	if (found.hashes.length) options.serverCertificateHashes = found.hashes;
	// on the wire the session is Wisp v2 whatever epoxy runs (pipeOf); a
	// browser that cannot say which protocol was answered is not offered the
	// server-opened stream
	options.protocols =
		'protocol' in WebTransport.prototype
			? [V2_PROTOCOL, SERVER_STREAM_PROTOCOL]
			: [V2_PROTOCOL];
	const session = new WebTransport(found.url, options);
	// the rejection is the caller's (ready's), not an unhandled one
	session.closed.catch(() => {});
	try {
		await timeout(session.ready, ms, 'the WebTransport handshake');
	} catch (error) {
		trace?.step(
			'carrier',
			`${what}: failed in ${took()} ms: ${errorFields(error)}`,
		);
		try {
			session.close();
		} catch {
			// closed already
		}
		throw error;
	}
	trace?.step(
		'carrier',
		`${what}: ready in ${took()} ms, protocol ${(session as { protocol?: string }).protocol || 'none'}`,
	);
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
	ms: number,
	prefer?: Via,
	trace?: StageTrace | null,
): Promise<Opened> {
	const direct = async (url: string): Promise<Opened> => ({
		session: await handshake({ url, hashes: [], key: '' }, ms, trace),
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
	const { found } = await discover(plan.discovery!, ms, false, trace);
	if (!found) throw first ?? new Error(NO_SESSION);
	// the document names the session that failed already
	if (first && found.url === plan.direct && !found.hashes.length) throw first;
	const by = async (found: Discovery): Promise<Opened> => ({
		session: await handshake(found, ms, trace),
		url: found.url,
		via: 'document',
	});
	try {
		return await by(found);
	} catch (error) {
		// it may have rotated since it was fetched (or kept)
		const again = (await discover(plan.discovery!, ms, true, trace)).found;
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

/** `packet` after its u32 LE length, in a buffer of its own */
function framed(packet: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(4 + packet.length);
	const n = packet.length;
	out[0] = n & 0xff;
	out[1] = (n >>> 8) & 0xff;
	out[2] = (n >>> 16) & 0xff;
	out[3] = (n >>> 24) & 0xff;
	out.set(packet, 4);
	return out;
}

/**
 * The lanes a server's INFO offers (extension 0xE1, lane 0 counted; 1 when
 * it offers none), and the INFO without that extension, as a relay that
 * knows no lanes would have sent it
 */
function readInfo(packet: Uint8Array<ArrayBuffer>): {
	lanes: number;
	info: Uint8Array<ArrayBuffer>;
} {
	let lanes = 1;
	const kept: Uint8Array[] = [packet.subarray(0, 7)];
	let at = 7;
	while (at + 5 <= packet.length) {
		const length = u32(packet, at + 1);
		const end = Math.min(packet.length, at + 5 + length);
		if (packet[at] === LANES_EXTENSION) {
			if (length >= 1 && at + 5 < packet.length) lanes = packet[at + 5];
		} else kept.push(packet.subarray(at, end));
		at = end;
	}
	if (lanes === 1) return { lanes, info: packet };
	const info = new Uint8Array(kept.reduce((n, part) => n + part.length, 0));
	let to = 0;
	for (const part of kept) {
		info.set(part, to);
		to += part.length;
	}
	return { lanes: Math.max(1, lanes), info };
}

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
 * Each packet on `readable`, after its u32 LE length, cut wherever QUIC cut.
 * Each byte is copied once, into its packet's own buffer, however many
 * chunks the packet spans: a relay's DATA packet is up to 128 KiB and a
 * reader that keeps up gets a chunk of a few QUIC packets, so gathering the
 * chunks into one buffer that grew with each copied the packet over again
 * for every chunk of it. Settles when the stream ends or fails.
 */
async function readPackets(
	readable: ReadableStream<Uint8Array>,
	take: (packet: Uint8Array<ArrayBuffer>) => void,
): Promise<unknown> {
	const reader = readable.getReader();
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
	} catch (error) {
		// the session or the stream failed: why
		return error;
	}
}

/** a stream the client did not ask for, reset both ways (SPEC.md: STREAM_UNWANTED) */
function refuse(stream: WebTransportBidirectionalStream) {
	let error: unknown;
	try {
		error = new WebTransportError('unwanted', {
			streamErrorCode: STREAM_UNWANTED,
		} as WebTransportErrorOptions);
	} catch {
		error = undefined;
	}
	stream.readable.cancel(error).catch(() => {});
	stream.writable.abort(error).catch(() => {});
}

/** every incoming bidirectional stream from here on, refused */
function refuseIncoming(
	reader: ReadableStreamDefaultReader<WebTransportBidirectionalStream>,
) {
	void (async () => {
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) return;
				refuse(value);
			}
		} catch {
			// the session ended
		}
	})();
}

/**
 * The session's lane 0, the Wisp stream: the one the relay opened when it
 * answered SERVER_STREAM_PROTOCOL (taken within `ms`), else one of the
 * client's. Every other incoming bidirectional stream is refused.
 */
async function laneZero(
	session: WebTransport,
	ms: number,
): Promise<{ stream: WebTransportBidirectionalStream; server: boolean }> {
	const incoming = session.incomingBidirectionalStreams.getReader();
	if ((session as { protocol?: string }).protocol === SERVER_STREAM_PROTOCOL) {
		const { value } = await timeout(
			incoming.read(),
			ms,
			"the relay's Wisp stream",
		);
		if (!value)
			throw new Error(
				'the session ended before the relay opened its Wisp stream',
			);
		refuseIncoming(incoming);
		return { stream: value, server: true };
	}
	refuseIncoming(incoming);
	return { stream: await session.createBidirectionalStream(), server: false };
}

/** one QUIC stream of the session that carries Wisp packets (SPEC.md, lanes) */
interface Lane {
	index: number;
	writer: WritableStreamDefaultWriter<Uint8Array>;
	/** the Wisp streams open on it */
	open: number;
	/** the bytes it carried, both ways, decayed by LANE_HALF_LIFE_MS */
	recent: number;
	at: number;
	/**
	 * what it sent (copies) until the relay first answers on it, to send
	 * again elsewhere if the relay refuses it; null once it answered (or
	 * past LANE_REPLAY_MAX)
	 */
	sent: Uint8Array[] | null;
	sentBytes: number;
	/** the relay answered on it: it is the relay's */
	heard: boolean;
}

/** how the carrier opens the Wisp connection on lane 0 */
interface Opening {
	/** epoxy runs Wisp v2 itself: the INFO exchange is epoxy's */
	v2: boolean;
	/** the relay opened lane 0 (its INFO and CONTINUE are on it already) */
	server: boolean;
	/** the most lanes to open, lane 0 counted */
	lanes: number;
	/** the relay refused lane `index` (LANE_REFUSED): it took the lanes below it */
	refused?: (index: number) => void;
}

/**
 * The Wisp packets of a session as epoxy reads and writes them: each read
 * is one packet (an ArrayBuffer), each write one packet. `first` settles
 * with the first packet the relay sends epoxy (read and kept for it).
 *
 * On the wire the session is always Wisp v2 (V2_PROTOCOL is offered): with
 * epoxy in v1 the carrier says the INFO itself (on a lane 0 of the client's
 * at once, before the relay's, which holyWisp takes; on the relay's after
 * its INFO, as the first packet the client writes) and hands epoxy the
 * CONTINUE for stream 0, the opening it waits for. The relay's INFO goes to
 * a v2 epoxy without the lanes extension. Once the CONTINUE is in, the
 * lanes the INFO offers are opened, and each CONNECT goes on the quietest
 * lane, the Wisp stream's packets with it (SPEC.md 3.3, 4.2).
 */
function pipeOf(
	session: WebTransport,
	stream: WebTransportBidirectionalStream,
	opening: Opening,
) {
	/** the UDP streams open, whose DATA may go as datagrams */
	const udp = new Set<number>();
	/** each UDP stream's CONNECT, written: its datagrams go after it */
	const udpOpened = new Map<number, Promise<unknown>>();
	let reading: ReadableStreamDefaultController<ArrayBuffer>;
	let ended = false;
	const { first, got, failed } = firstPacket();
	const stats: PipeStats = {
		sent: 0,
		received: 0,
		datagramsSent: 0,
		datagramsReceived: 0,
		lanes: 1,
		server: opening.server,
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
	const read = new ReadableStream<ArrayBuffer>({
		start(controller) {
			reading = controller;
		},
		cancel() {
			end();
		},
	});
	session.closed.then(end, end);

	const lanes: Lane[] = [];
	/** each Wisp stream's lane, kept after it closes: a reused id stays on it */
	const laneOf = new Map<number, Lane>();
	const open = new Set<number>();
	const account = (lane: Lane, bytes: number) => {
		const now = performance.now();
		lane.recent =
			lane.recent * 2 ** ((lane.at - now) / LANE_HALF_LIFE_MS) + bytes;
		lane.at = now;
	};
	/** the quietest lane, then the one with the fewest streams, then the first */
	const pick = (): Lane => {
		if (lanes.length === 1) return lanes[0];
		for (const lane of lanes) account(lane, 0);
		const quietest = Math.min(...lanes.map((lane) => lane.recent));
		let best = lanes[0];
		let fewest = Infinity;
		for (const lane of lanes)
			if (lane.recent <= quietest + LANE_QUIET_BYTES && lane.open < fewest) {
				best = lane;
				fewest = lane.open;
			}
		return best;
	};
	const closed = (id: number) => {
		if (open.delete(id)) laneOf.get(id)!.open--;
	};
	const send = (lane: Lane, packet: Uint8Array) => {
		account(lane, packet.length);
		if (lane.sent) {
			lane.sent.push(packet.slice());
			lane.sentBytes += packet.length;
			if (lane.sentBytes > LANE_REPLAY_MAX) lane.sent = null;
		}
		// not awaited: a lane that waits for the relay's credit holds up
		// only its own writes (Wisp's CONTINUE bounds what each stream has
		// outstanding). A lane the relay has not answered on yet may be
		// refused: its reader tells (laneEnded)
		const written = lane.writer.write(framed(packet));
		written.catch(() => lane.heard && end());
		return written;
	};
	/**
	 * A lane the relay refused (LANE_REFUSED, before it answered on it): the
	 * relay acted on nothing it carried, so its Wisp streams go on the other
	 * lanes, what it sent sent again there in order, and the session goes
	 * on. Any other end of a lane ends the Wisp connection (SPEC.md 3.5).
	 */
	const laneEnded = (lane: Lane, error: unknown) => {
		const code = (error as { streamErrorCode?: unknown } | undefined)
			?.streamErrorCode;
		const sent = lane.sent;
		if (
			ended ||
			lane.index === 0 ||
			lane.heard ||
			code !== LANE_REFUSED ||
			!sent
		)
			return end();
		lanes.splice(lanes.indexOf(lane), 1);
		lane.sent = null;
		stats.lanes = Math.min(stats.lanes, lane.index);
		opening.refused?.(lane.index);
		for (const [id, on] of laneOf)
			if (on === lane) {
				const to = pick();
				laneOf.set(id, to);
				if (open.has(id)) to.open++;
			}
		for (const packet of sent)
			void send(
				packet.length >= 5
					? (laneOf.get(streamOf(packet)) ?? lanes[0])
					: lanes[0],
				packet,
			);
	};
	const addLane = (
		index: number,
		readable: ReadableStream<Uint8Array>,
		writer: WritableStreamDefaultWriter<Uint8Array>,
	) => {
		const lane: Lane = {
			index,
			writer,
			open: 0,
			recent: 0,
			at: 0,
			// lane 0 is the session's own; another is the relay's once it answers on it
			sent: index === 0 ? null : [],
			sentBytes: 0,
			heard: index === 0,
		};
		lanes.push(lane);
		lanes.sort((a, b) => a.index - b.index);
		void readPackets(readable, (packet) => take(packet, lane)).then((error) =>
			laneEnded(lane, error),
		);
		return lane;
	};

	/** where the opening is: the relay's INFO, then its CONTINUE for stream 0 */
	let state: 'info' | 'continue' | 'open' = 'info';
	let offered = 1;
	let infoSaid = false;
	/**
	 * the carrier's own INFO, for an epoxy in v1: Wisp 2.0 with UDP. Never
	 * stream credit (0xE2), even when the relay offers it: a v1 epoxy grants
	 * nothing, and each TCP stream would stop at its initial window.
	 */
	const sayInfo = () => {
		if (infoSaid || opening.v2) return;
		infoSaid = true;
		void send(
			lanes[0],
			new Uint8Array([INFO, 0, 0, 0, 0, 2, 0, 0x01, 0, 0, 0, 0]),
		);
	};
	const openLanes = () => {
		const count = stats.lanes;
		for (let index = 1; index < count; index++)
			session.createBidirectionalStream().then(
				(stream) => {
					if (ended) return;
					const writer = stream.writable.getWriter();
					// the LANE packet first: type, stream 0, the lane's index
					// (a refusal is told by its reader: laneEnded)
					writer
						.write(framed(new Uint8Array([LANE, 0, 0, 0, 0, index])))
						.catch(() => {});
					addLane(index, stream.readable, writer);
				},
				() => {
					// a lane that cannot be had is no lane
				},
			);
	};
	/** a packet of the opening: what epoxy gets of it (null: nothing) */
	const opened = (packet: Uint8Array<ArrayBuffer>) => {
		const type = packet[0];
		if (state === 'info' && type === INFO && streamOf(packet) === 0) {
			const { lanes, info } = readInfo(packet);
			offered = lanes;
			stats.lanes = Math.max(1, Math.min(offered, opening.lanes, MAX_LANES));
			state = 'continue';
			sayInfo();
			return opening.v2 ? info : null;
		}
		if (type === CONTINUE && streamOf(packet) === 0 && offered > 1) openLanes();
		state = 'open';
		return packet;
	};

	/** a packet from the relay, in a buffer of its own (handed to epoxy as it is) */
	const take = (packet: Uint8Array<ArrayBuffer>, lane: Lane | null) => {
		if (ended) return;
		if (lane) {
			account(lane, packet.length);
			if (!lane.heard) {
				lane.heard = true;
				lane.sent = null;
			}
		}
		if (state !== 'open' && lane?.index === 0) {
			const passed = opened(packet);
			if (!passed) return;
			packet = passed;
		}
		if (packet[0] === CLOSE && packet.length >= 5) {
			const id = streamOf(packet);
			udp.delete(id);
			closed(id);
		}
		stats.received++;
		reading.enqueue(packet.buffer);
		got();
	};

	addLane(0, stream.readable, stream.writable.getWriter());
	// before the relay's INFO, on a lane 0 of the client's (holyWisp opens
	// the stream with its INFO before it reads the client's)
	if (!opening.server) sayInfo();

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
					null,
				);
			}
		} catch {
			// the session ended
		}
	})();

	const datagramWriter = session.datagrams.writable.getWriter();
	const write = new WritableStream<Uint8Array>({
		async write(packet) {
			stats.sent++;
			const type = packet[0];
			let lane = lanes[0];
			if (packet.length >= 5) {
				const id = streamOf(packet);
				if (type === CONNECT && id !== 0) {
					lane = laneOf.get(id) ?? pick();
					laneOf.set(id, lane);
					if (!open.has(id)) {
						open.add(id);
						lane.open++;
					}
					const written = send(lane, packet);
					if (packet[5] === UDP) {
						udp.add(id);
						udpOpened.set(id, written);
					}
					return;
				}
				if (id !== 0) lane = laneOf.get(id) ?? lanes[0];
				if (type === CLOSE) {
					udp.delete(id);
					udpOpened.delete(id);
					closed(id);
				} else if (
					type === DATA &&
					udp.has(id) &&
					packet.length <= session.datagrams.maxDatagramSize
				) {
					// after its CONNECT is the stream's; a datagram the
					// connection drops is lost, as UDP's is
					const after = udpOpened.get(id);
					if (after) {
						udpOpened.delete(id);
						await after.catch(() => {});
					}
					await datagramWriter.ready;
					stats.datagramsSent++;
					datagramWriter.write(packet).catch(() => {});
					return;
				}
			}
			void send(lane, packet);
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
	lanes: number,
): Promise<OpenCarrier & { via: Via }> {
	const trace = startTrace(
		`carrier session to the relay ${originOf(plan.direct ?? plan.discovery ?? '')}`,
	);
	let opened: Opened;
	try {
		opened = await openSession(plan, ms, memory.via(plan.key), trace);
	} catch (error) {
		trace?.fail('carrier', `no session: ${errorFields(error)}`);
		trace?.tell();
		throw error;
	}
	const { session, url, via } = opened;
	const close = () => {
		try {
			session.close();
		} catch {
			// closed already
		}
	};
	try {
		const zero = await laneZero(session, ms);
		trace?.step(
			'carrier',
			`Wisp stream: lane 0 ${zero.server ? "the relay's" : "the client's"}`,
		);
		const { pipe, first, stats } = pipeOf(session, zero.stream, {
			v2,
			server: zero.server,
			lanes: Math.min(lanes, laneCaps.get(plan.key) ?? lanes),
			refused: (index) => {
				const took = Math.min(index, laneCaps.get(plan.key) ?? index);
				if (laneCaps.get(plan.key) === took) return;
				laneCaps.set(plan.key, took);
				wispNote(
					'warn',
					`the relay refused lane ${index} (LANE_REFUSED): its Wisp streams went on the other lanes, and sessions to it open ${took} lanes from now on`,
				);
			},
		});
		await timeout(first, ms, 'the Wisp stream');
		trace?.step('carrier', "the relay's first Wisp packet came");
		trace?.tell(
			`via ${via === 'document' ? 'the discovery document' : 'the wisp URL'}`,
		);
		const ended = session.closed.then(() => {});
		ended.catch(() => {});
		return { carrier: 'webtransport', url, via, pipe, close, ended, stats };
	} catch (error) {
		trace?.fail('carrier', `Wisp stream: ${errorFields(error)}`);
		trace?.tell();
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

/**
 * The packets of a wisp WebSocket to `url`, open once the relay spoke, as
 * epoxy would open its own (ShardedTransport, given a wisp URL)
 */
export async function wispSocketPipe(
	url: string,
	protocols: string[],
): Promise<WispPipe> {
	return (await socketCarrier(url, protocols, DEFAULT_SOCKET_MS)).pipe;
}

type TransportClass = new (...args: unknown[]) => ProxyTransport;

/** a carrier chosen for a relay: null when neither could be opened */
interface Choice {
	plan: RelayPlan;
	open: OpenCarrier | null;
	why: string;
	ms: number;
	/** what the carrier host said, when the carrier is its */
	shared?: CarrierGiven;
}

/**
 * Whether a transport takes its wisp connection as a function transport
 * (`wisp` a function): epoxy's builds do, and tell their version
 * (`client_version`); a transport that does not say so (libcurl) keeps its
 * wisp URL
 */
const takesPipes = (transport: ProxyTransport) =>
	typeof (transport as { client_version?: unknown }).client_version ===
	'object';

/**
 * What chooses and opens a relay's carrier (see the top of the file): the
 * transport's own (CarrierTransport), or the carrier host's that every
 * transport of the origin shares (carrierHost.ts)
 */
export class Chooser {
	#wisp: string;
	#first: { wisp_v2?: boolean; wisp_ws_protocols?: string[] };
	#webTransport: WispWebTransportOptions | null;
	/** the session tried beside the WebSocket, settled (for tests and the demo) */
	probed: Promise<boolean> = Promise.resolve(false);

	constructor(
		wisp: string,
		first: unknown,
		webTransport: WispWebTransportOptions | null,
	) {
		this.#wisp = wisp;
		this.#first = (first ?? {}) as {
			wisp_v2?: boolean;
			wisp_ws_protocols?: string[];
		};
		this.#webTransport = webTransport;
	}

	get #v2(): boolean {
		return Boolean(this.#first.wisp_v2);
	}

	get #timeoutMs(): number {
		return this.#webTransport?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/** the WebSocket, opened as epoxy's own would be */
	socket(): Promise<OpenCarrier> {
		const protocols = [...(this.#first.wisp_ws_protocols ?? [])];
		// epoxy asks for v2 with a protocol of its own; holyWisp takes any
		if (this.#v2) protocols.push(crypto.randomUUID());
		return socketCarrier(
			this.#wisp,
			protocols,
			Math.max(DEFAULT_SOCKET_MS, this.#timeoutMs),
		);
	}

	/** a session, remembered as working or failing */
	#session(plan: RelayPlan): Promise<OpenCarrier> {
		return sessionCarrier(
			plan,
			this.#v2,
			this.#timeoutMs,
			Math.max(1, Math.floor(this.#webTransport?.lanes ?? MAX_LANES)),
		).then(
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
	async choose(
		plan: RelayPlan,
	): Promise<{ open: OpenCarrier | null; why: string }> {
		const socket = () =>
			this.socket().catch((error) => {
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
				`trying the WebTransport transport to ${target} in the background, for the next start`,
			);
			const started = performance.now();
			this.probed = this.#session(plan).then(
				(open) => {
					open.close();
					wispNote(
						'info',
						`WebTransport session established in ${Math.round(performance.now() - started)} ms in the background: the next start takes it`,
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
			`trying the WebTransport transport to ${target}, the WebSocket on standby`,
		);
		return this.#race(plan, socket);
	}

	/**
	 * Nothing known: the session is the carrier when it is up within
	 * firstStartMs() of the start; the WebSocket, opened beside it, only when
	 * the session failed or is not up by then, and past that, whichever is up
	 * first. The other is closed when it opens.
	 */
	async #race(
		plan: RelayPlan,
		openSocket: () => Promise<OpenCarrier | null>,
	): Promise<{ open: OpenCarrier | null; why: string }> {
		const budget = firstStartMs(this.#timeoutMs);
		const session = this.#session(plan);
		const socket = openSocket();
		this.probed = session.then(
			() => true,
			() => false,
		);
		let sessionError: unknown = null;
		const bySession = session.catch((error: unknown) => {
			sessionError = error;
			return null;
		});
		// the one not taken is closed when it opens
		const loser = (other: Promise<OpenCarrier | null>) =>
			void other.then(
				(open) => open?.close(),
				() => {},
			);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<'late'>((resolve) => {
			timer = setTimeout(() => resolve('late'), budget);
		});
		const first = await Promise.race([bySession, late]);
		clearTimeout(timer);
		if (first !== 'late') {
			if (first) {
				loser(socket);
				return { open: first, why: '' };
			}
			// it failed: the WebSocket, as soon as it is up
			const open = await socket;
			unavailable(
				plan.key,
				sessionError,
				open ? ', trying the next transport' : ', and the WebSocket neither',
			);
			return {
				open,
				why: open
					? short(sessionError)
					: `no session either: ${short(sessionError)}`,
			};
		}
		// not up in time: the WebSocket when it is up, unless the session is
		// up first; the session goes on, and its outcome is remembered
		type Won = { open: OpenCarrier | null; from: 'session' | 'socket' };
		const won = await Promise.race<Won>([
			bySession.then((open) =>
				open
					? { open, from: 'session' }
					: socket.then((open) => ({ open, from: 'socket' })),
			),
			socket.then((open): Promise<Won> | Won =>
				open
					? { open, from: 'socket' }
					: bySession.then((open) => ({ open, from: 'session' })),
			),
		]);
		if (won.from === 'session') {
			loser(socket);
			if (!won.open)
				unavailable(plan.key, sessionError, ', and the WebSocket neither');
			return {
				open: won.open,
				why: won.open ? '' : `no session either: ${short(sessionError)}`,
			};
		}
		loser(session);
		if (sessionError)
			unavailable(plan.key, sessionError, ', trying the next transport');
		else {
			wispNote(
				'info',
				`WebTransport unavailable (not up within ${budget} ms), trying the next transport; WebTransport on the next start if it comes up`,
			);
			// one that never comes up is told as any failure is
			void bySession.then((open) => {
				if (!open) unavailable(plan.key, sessionError, '');
			});
		}
		return {
			open: won.open,
			why: sessionError
				? short(sessionError)
				: `not up within ${budget} ms (remembered for the next start)`,
		};
	}
}

/**
 * Epoxy over the relay's WebTransport session or its WebSocket, whichever
 * init() chose (see the top of the file). Until init() chose, and when
 * neither could be opened, `base` is the transport as given.
 */
export class CarrierTransport implements ProxyTransport {
	#Transport: TransportClass | null = null;
	#options: unknown[];
	#wisp: string;
	/** null: off, the transport as given on its own WebSocket */
	#webTransport: WispWebTransportOptions | null;
	#label: CarrierLabel | null;
	/** the transport as given, once its class is in; the chosen one after init() */
	#base: ProxyTransport | null = null;
	/** settles once the transport's class is in */
	#loaded: Promise<void>;
	/** the carrier being chosen before init() asked (while the module loads) */
	#choice: Promise<Choice> | null = null;
	#starting: Promise<void> | null = null;
	/** without `webTransport`: epoxy was handed its WebSocket as its function transport */
	#piped = false;
	/** which carrier the wisp connection rides: null before init() chose */
	carrier: Carrier | null = null;
	/** the choice, as the console and the host have it */
	info: CarrierInfo | null = null;
	#chooser: Chooser;

	/**
	 * `Transport` may be the promise of the class (its module loading): the
	 * carrier is then chosen at once, while the module loads, as nothing of
	 * the choice needs the transport
	 */
	constructor(
		Transport: TransportClass | Promise<TransportClass>,
		options: unknown[],
		webTransport: WispWebTransportOptions | null,
		label: CarrierLabel | null = null,
	) {
		this.#options = options;
		this.#wisp = (options[0] as { wisp: string }).wisp;
		this.#webTransport = webTransport;
		this.#label = label;
		this.#chooser = new Chooser(this.#wisp, options[0], webTransport);
		if (typeof Transport === 'function') {
			this.#adopt(Transport);
			this.#loaded = Promise.resolve();
			return;
		}
		if (webTransport) this.#choice = this.#chooseTimed();
		this.#loaded = Transport.then(
			(Transport) => this.#adopt(Transport),
			(error: unknown) => {
				// no transport will ride what was opened
				void this.#choice?.then(({ open }) => open?.close());
				throw error;
			},
		);
		this.#loaded.catch(() => {});
	}

	#adopt(Transport: TransportClass) {
		this.#Transport = Transport;
		this.#base = new Transport(...this.#options);
	}

	/** the session tried beside the WebSocket, settled (for tests and the demo) */
	get probed(): Promise<boolean> {
		return this.#chooser.probed;
	}

	/** settles once the transport's class is in (constructed with its promise) */
	get loaded(): Promise<void> {
		return this.#loaded;
	}

	/**
	 * whether init() opens the wisp connection itself (no `webTransport`):
	 * warmTransport must not open another
	 */
	get opensWisp(): boolean {
		return !this.#webTransport && !this.#piped;
	}

	/** the transport in use (serveTransport and webTransportHost look through it) */
	get base(): ProxyTransport {
		return this.#base!;
	}

	get ready(): boolean {
		return this.#base?.ready ?? false;
	}
	set ready(value: boolean) {
		if (this.#base) this.#base.ready = value;
	}

	get client(): unknown {
		return (this.#base as { client?: unknown } | null)?.client;
	}

	get fieldSupport(): unknown {
		return (this.#base as { fieldSupport?: unknown } | null)?.fieldSupport;
	}

	/** the transport's answer for `host`'s HTTPS record (RevivingTransport's httpsAnswer) */
	async httpsAnswer(
		host: string,
		headers?: RawHeaders,
	): Promise<ArrayBuffer | null> {
		await this.init();
		const base = this.#base as {
			httpsAnswer?: (
				host: string,
				headers?: RawHeaders,
			) => Promise<ArrayBuffer | null>;
		} | null;
		return (await base?.httpsAnswer?.(host, headers)) ?? null;
	}

	init(): Promise<void> {
		this.#starting ??= this.#start().catch((error) => {
			this.#starting = null;
			throw error;
		});
		return this.#starting;
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
		let started = performance.now();
		// said once, unless the WebSocket is the carrier host's, up already
		let told = false;
		const connecting = () => {
			if (!told) this.#connecting(true);
			told = true;
		};
		if (takesPipes(this.#base!)) {
			const piped = this.#unchosen();
			const opening = (async (): Promise<{
				open: OpenCarrier | null;
				given: CarrierGiven | null;
			}> => {
				const hosted = await this.#hosted(null);
				if (!hosted?.open || !hosted.given.upMs) connecting();
				if (hosted) return hosted;
				try {
					return { open: await this.#chooser.socket(), given: null };
				} catch (error) {
					wispNote(
						'warn',
						`websocket did not open (${short(error)}); the first request tries again`,
					);
					return { open: null, given: null };
				}
			})();
			const [{ open, given }] = await Promise.all([
				opening,
				// epoxy's module loads while the WebSocket opens
				piped.transport.init().catch(() => {}),
			]);
			if (open) {
				const ms = Math.round(performance.now() - started);
				piped.give(this.#pipes(open, key));
				this.#base = piped.transport;
				this.#piped = true;
				this.carrier = 'websocket';
				if (given?.upMs) this.#riding(given);
				await this.#base.init();
				this.#announce(key, {
					carrier: 'websocket',
					url: this.#wisp,
					ms,
					why: 'off',
					...(given && { shared: given.upMs }),
				});
				return;
			}
		}
		connecting();
		await this.#base!.init();
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

	/** a choice of this transport's carrier, and how long it took */
	async #chooseTimed(): Promise<Choice> {
		const plan = relayPlan(this.#wisp, this.#webTransport!);
		const started = performance.now();
		const hosted = await this.#hosted(this.#webTransport);
		if (hosted)
			return {
				plan,
				open: hosted.open,
				why: hosted.given.why,
				ms: Math.round(performance.now() - started),
				shared: hosted.given,
			};
		const { open, why } = await this.#chooser.choose(plan);
		return { plan, open, why, ms: Math.round(performance.now() - started) };
	}

	/** a rider of the carrier host's (carrierHost.ts), or null to open a carrier here */
	#hosted(webTransport: WispWebTransportOptions | null) {
		const first = this.#options[0] as {
			wisp_v2?: boolean;
			wisp_ws_protocols?: string[];
		};
		const ms = webTransport?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		return askCarrierHost(
			{
				wisp: this.#wisp,
				first: {
					wisp_v2: Boolean(first.wisp_v2),
					...(first.wisp_ws_protocols && {
						wisp_ws_protocols: [...first.wisp_ws_protocols],
					}),
				},
				webTransport,
			},
			// the host may choose as long as a transport would, the WebSocket's
			// wait included
			firstStartMs(ms) + Math.max(10000, ms),
		);
	}

	/** the note of a carrier the host shares: what it rides, and since when */
	#riding(given: CarrierGiven) {
		const tell = [this.#what, shapeOf(given.lanes, given.serverStream)]
			.filter(Boolean)
			.join('; ');
		const name =
			given.carrier === 'webtransport' ? 'WebTransport session' : 'WebSocket';
		wispNote(
			'info',
			`riding the ${name} to ${given.url} that is up already (${Math.round(given.upMs / 1000)} s, ${given.riders} transport${given.riders === 1 ? '' : 's'} on it): wisp transport ${LABEL[given.carrier ?? 'websocket']}${tell ? ` (${tell})` : ''}`,
		);
	}

	/**
	 * The transport over a carrier not chosen yet: it is made, and its init()
	 * (epoxy's wasm module) run, while the carrier is chosen; its wisp
	 * connection, which nothing asks for before the choice, is the one
	 * `give` hands it
	 */
	#unchosen(): {
		transport: ProxyTransport;
		give: (pipes: (v2: boolean) => Promise<WispPipe>) => void;
	} {
		let give!: (pipes: (v2: boolean) => Promise<WispPipe>) => void;
		const pipes = new Promise<(v2: boolean) => Promise<WispPipe>>(
			(resolve) => (give = resolve),
		);
		const [first, ...rest] = this.#options;
		const transport = new this.#Transport!(
			{
				...(first as object),
				wisp: async (v2: boolean) => (await pipes)(v2),
			},
			...rest,
		);
		return { transport, give };
	}

	async #start() {
		await this.#loaded;
		if (this.carrier === null) {
			if (!this.#webTransport) return this.#plain();
			const choosing = this.#choice ?? this.#chooseTimed();
			this.#choice = null;
			const piped = this.#unchosen();
			// epoxy's module loads while the carrier is chosen
			const [{ plan, open, why, ms, shared }] = await Promise.all([
				choosing,
				piped.transport.init().catch(() => {}),
			]);
			if (open) {
				piped.give(this.#pipes(open, plan.key));
				this.#base = piped.transport;
			}
			this.carrier = open?.carrier ?? 'websocket';
			// the session's shape: its own, or what the carrier host says of its
			const lanes = open?.stats?.lanes ?? shared?.lanes;
			const server = open?.stats?.server ?? shared?.serverStream;
			const session = this.carrier === 'webtransport' && lanes !== undefined;
			if (open && shared?.upMs) this.#riding(shared);
			else if (this.carrier === 'webtransport') {
				const tell = [this.#what, shapeOf(lanes, server)]
					.filter(Boolean)
					.join('; ');
				wispNote(
					'info',
					`WebTransport session established in ${ms} ms: wisp transport ${LABEL.webtransport} to ${open!.url}${tell ? ` (${tell})` : ''}`,
				);
			} else this.#connecting();
			this.#announce(plan.key, {
				carrier: this.carrier,
				url: open?.url ?? this.#wisp,
				ms,
				...(this.carrier === 'websocket' && { why }),
				...(open && shared && { shared: shared.upMs }),
				...(session && { lanes, serverStream: Boolean(server) }),
			});
		}
		await this.#base!.init();
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
		// the carrier host tells the end of the carrier it shares
		if (!open.hosted) watchEnd(open, key);
		return async () => {
			const mine = unused;
			unused = null;
			if (!mine)
				throw new Error(
					`${CARRIER_LOST}: the ${open.carrier === 'webtransport' ? 'WebTransport session' : 'WebSocket'} to the wisp relay ended`,
				);
			return {
				read: mine.pipe.read,
				write: promptSink(mine.pipe.write),
				...(mine.more && { more: mine.more }),
			};
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
		return this.#base!.request(remote, method, body, headers, signal);
	}

	connect(...args: Parameters<ProxyTransport['connect']>) {
		return this.#base!.connect(...args);
	}
}
