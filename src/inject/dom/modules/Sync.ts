import { decodeBase64, encodeBase64 } from '../../../base64';
import { decodeCookie, joinAnswer } from '../../../encodeCookie';
import { geckoXHR, queueXHR } from '../../../routeURL';
import { urlLike } from '../../../StompURL';
import { ProcessData, SerializableRequestInit, SyncBody } from '../../../sync';
import { headersRecord } from '../../../syncHeaders';
import { SW_KICK, SYNC_KICK_MS } from '../../../transport/messages';
import Module from '../../Module';
import ResourceTimingModule from '../../modules/ResourceTiming';
import DocumentClient from '../Client';

const statusEmpty: number[] = [101, 204, 205, 304];

// wall-clock limits: the service worker is single threaded, so even a
// loopback route (cookies, storage) waits while it rewrites a multi-megabyte
// script, which takes seconds for YouTube's main bundle
const TIMEOUT = 30e3;
const LOOPBACK_TIMEOUT = 10e3;
/** how long a page's read of a timing entry waits for the worker's note of it */
const KEPT_LOADS_LIMIT = 1e3;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Chrome's beacon quota: bytes of beacons in flight, per document */
export const BEACON_QUOTA = 64 * 1024;

/**
 * The beacons in flight a write may bring the document to (the bridge counts
 * every beacon it sent, reads included); the rest of the quota is kept for
 * reads, which cannot go another way.
 */
export const WRITE_BUDGET = BEACON_QUOTA - 24 * 1024;

// A beacon's share of the quota is given back only once the page has run the
// task that completes it, which a page spinning here never does, and the
// browser says nothing when it has. The bytes this bundle's document sent are
// counted here (the snapshot `navigator` is this realm's, so every client the
// bundle runs sends from one document) until a timer well after they were
// sent, by which time their completion has run unless the page never let it.
// A caller with a way around the bridge (an asynchronous write) is held to a
// budget under the quota, so what it leaves is there for the reads, which
// have no other way.
const RELEASE_MS = 100;
const nativeSetTimeout = globalThis.setTimeout;
let inflight = 0;

function byteLength(text: string, over: number) {
	// UTF-8 takes at least one byte and at most three per code unit
	if (text.length > over) return text.length;
	if (text.length * 3 <= over) return text.length;
	return encoder.encode(text).length;
}

interface SyncResponse extends Response {
	rawUrl: string;
	rawArrayBuffer: ArrayBuffer;
}

interface SyncResponseInit extends SyncBody {
	error: { message: string };
	init: ResponseInit;
	url: string;
}

// taken when the bundle loads, before page code can replace them
const objectTag = Reflect.getOwnPropertyDescriptor(
	Object.prototype,
	'toString',
)!.value as () => string;
const isView = ArrayBuffer.isView;

// The answer is read in the cookies of the document that sent the request:
// this bundle's own (the snapshot `navigator` above is its). A client the
// bundle runs in another window (an about:blank child, a popup) sees the same
// jar while its frame is there, but a frame the page removed keeps a document
// with no browsing context, whose cookie reads "" whatever the jar holds:
// Sentry and rrweb on discord.com take functions from a hidden iframe they
// remove at once, and every call through that realm spun to the limit.
const nativeCookie = Reflect.getOwnPropertyDescriptor(
	Document.prototype,
	'cookie',
)!;
// `document` is unforgeable: the live one is the bundle's own
const readCookies = (): string =>
	Reflect.apply(nativeCookie.get!, globalThis.document, []);
const writeCookie = (value: string) =>
	Reflect.apply(nativeCookie.set!, globalThis.document, [value]);

// taken when the bundle loads, like the rest: what tells the controller
const NativeEvent = globalThis.Event;
const dispatchEvent = EventTarget.prototype.dispatchEvent;
const parentOf = Reflect.getOwnPropertyDescriptor(globalThis, 'parent')?.get;
const framesIn = Reflect.getOwnPropertyDescriptor(globalThis, 'length')?.get;
/** how far up, and how far along each window's frames, the controller is looked for */
const KICK_DEPTH = 8;
const KICK_FRAMES = 64;

/**
 * Tell the controller at `directory` that this page waits for the worker
 * inside one of its own tasks. The answer to a synchronous ask comes from
 * the service worker, and a worker the browser stopped (it stops one
 * nothing reached for 30 seconds) starts again knowing no controller: it
 * asks for a handshake, which the controller hears in a task of its own.
 * A controller on this page's thread (the host's document, or the
 * controller frame beside this page's) gets no task while the page spins
 * here, so the first document.cookie or localStorage a page touched after
 * sitting idle froze it for the bridge's whole limit. An event is
 * dispatched where it stands: on every window above this one and on their
 * frames, of a type only the page and its controller know (the address is
 * in no page's reach). Its listener offers the handshake from inside this
 * task (StompController's #standIn); windows of another origin refuse the
 * event, and no other window listens for it.
 */
function kick(from: Window, directory: string) {
	if (!parentOf || !framesIn) return;
	const event = new NativeEvent(`${SW_KICK}${directory}`);
	const tell = (target: Window) => {
		try {
			Reflect.apply(dispatchEvent, target, [event]);
		} catch (error) {
			// a window of another origin
		}
	};
	let window = from;
	for (let depth = 0; depth < KICK_DEPTH; depth++) {
		let parent: Window | null;
		try {
			parent = Reflect.apply(parentOf, window, []);
		} catch (error) {
			return;
		}
		if (!parent || parent === window) return;
		tell(parent);
		let frames = 0;
		try {
			frames = Reflect.apply(framesIn, parent, []);
		} catch (error) {
			// no frames to look in
		}
		for (let index = 0; index < frames && index < KICK_FRAMES; index++) {
			try {
				tell(parent[index]);
			} catch (error) {
				// gone since it was counted
			}
		}
		window = parent;
	}
}

function createResponse(init: SyncResponseInit): SyncResponse {
	if (init.error) {
		throw new TypeError(init.error.message);
	}

	// the bytes the worker read: UTF-8 text encodes back to them exactly
	const { buffer: rawArrayBuffer } =
		init.base64 !== undefined
			? decodeBase64(init.base64)
			: encoder.encode(init.text ?? '');

	let response: Response & Partial<SyncResponse>;

	if (!init) {
		throw new Error('No init');
	}

	if (statusEmpty.includes(init.init.status!)) {
		response = new Response(undefined, init.init);
	} else {
		response = new Response(rawArrayBuffer, init.init);
	}

	response.rawUrl = init.url;
	response.rawArrayBuffer = rawArrayBuffer;

	return <SyncResponse>response;
}

function parseAPI(response: SyncResponse) {
	const parsed = JSON.parse(decoder.decode(response.rawArrayBuffer));

	if (response.ok) {
		return parsed;
	} else {
		throw parsed;
	}
}

const apiInit = (args: unknown[]) => ({
	method: 'POST',
	headers: {
		'content-type': 'application/json',
	},
	body: JSON.stringify(args),
});

export default class SyncModule extends Module<DocumentClient> {
	apply() {
		// resource timing asks the worker how a load its kept script response
		// answered was delivered, when a page reads the entry before the
		// worker's note of it has come
		const timing = this.client.getModule(ResourceTimingModule);
		if (timing)
			timing.askKeptLoads = (urls) =>
				parseAPI(
					this.fetch(
						`${this.client.directory}timing/kept`,
						apiInit([urls]),
						true,
						KEPT_LOADS_LIMIT,
					),
				);
	}
	jsonAPI(url: urlLike, ...args: any[]) {
		return parseAPI(this.fetch(url, apiInit(args), true));
	}
	/**
	 * `jsonAPI` for a caller that has another way: null, and nothing sent,
	 * when the request would take this document's beacons in flight past
	 * `budget` bytes or the browser refused it
	 */
	tryJsonAPI(
		budget: number,
		url: urlLike,
		...args: any[]
	): { value: any } | null {
		const response = this.fetch(url, apiInit(args), true, undefined, budget);
		return response && { value: parseAPI(response) };
	}
	/**
	 * Synchronous ServiceWorker fetch API
	 * @param url
	 * @param init
	 * @param loopback goes to serviceworker route that does not fetch external urls
	 */
	fetch(
		url: urlLike,
		init?: Omit<RequestInit, 'signal'>,
		loopback?: boolean,
		limit?: number,
	): SyncResponse;
	fetch(
		url: urlLike,
		init: Omit<RequestInit, 'signal'>,
		loopback: boolean,
		limit: number | undefined,
		budget: number,
	): SyncResponse | null;
	fetch(
		url: urlLike,
		init: Omit<RequestInit, 'signal'> = {},
		loopback = false,
		// a shorter limit than the bridge's own, for a caller that has a
		// fallback
		limit?: number,
		// with one, a request over it is not sent and the answer is null
		budget?: number,
	): SyncResponse | null {
		// STomp's own API (storage, cookies, timing) from a document no
		// worker controls that runs a bundle of its own (an <object>'s or
		// <embed>'s document, a blob: copy): its location resolves no route
		// and nothing it sends reaches the worker, so the nearest document a
		// worker controls asks for it, as one injected into an about:blank
		// document does by running its creator's bundle. A page's own
		// synchronous request is answered as before
		if (loopback && !this.client.controlled) {
			// the bridge as a getter of that client: a bundle of its own has
			// module classes of its own (DocumentClient.syncBridge)
			const routed = this.client.routedClient() as {
				syncBridge?: SyncModule;
			} | null;
			const sync =
				routed && routed !== (this.client as unknown)
					? (routed.syncBridge ?? null)
					: null;
			if (sync && sync !== this)
				return budget === undefined
					? sync.fetch(url, init, loopback, limit)
					: sync.fetch(url, init, loopback, limit, budget);
		}
		const processInit: SerializableRequestInit = {};

		processInit.cache = init.cache;
		processInit.credentials = init.credentials;
		processInit.integrity = init.integrity;
		processInit.keepalive = init.keepalive;
		processInit.method = init.method;
		processInit.mode = init.mode;
		processInit.redirect = init.redirect;
		// the worker builds this request itself, so its referrer would be the
		// worker's: the document's routed URL names the initiator instead. A
		// loopback route (storage, cookies) is told who asks in its arguments,
		// and every byte of a beacon counts against the quota
		processInit.referrer =
			init.referrer ?? (loopback ? undefined : location.href);
		processInit.referrerPolicy = init.referrerPolicy;

		// a plain record went nowhere before (its branch tested `=== null`):
		// jsonAPI's content-type never reached the worker
		processInit.headers = headersRecord(init.headers);

		// against this bundle's location, or for a document a worker controls
		// where that resolves nothing (a srcdoc document's location is
		// about:srcdoc), the proxy's scope. One no worker controls (a popup's
		// about:blank) has nothing to send a route to: it throws, as before,
		// and its caller asks a controlled client.
		let resolved: URL;
		try {
			resolved = new URL(url, location.toString());
		} catch (error) {
			if (!this.client.controlled) throw error;
			resolved = new URL(
				url,
				`${this.client.baseURI.origin}${this.client.scope}`,
			);
		}
		const data: ProcessData = {
			url: resolved.toString(),
			init: processInit,
		};

		// a binary body goes as its bytes (a UTF-8 decode would replace every
		// byte that is not UTF-8); either kind of buffer, from any realm
		const body = init.body;
		if (typeof body === 'string') {
			data.body = body;
		} else if (isView(body)) {
			data.bodyBase64 = encodeBase64(
				new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
			);
		} else if (
			body !== null &&
			typeof body === 'object' &&
			Reflect.apply(objectTag, body, []) === '[object ArrayBuffer]'
		) {
			data.bodyBase64 = encodeBase64(new Uint8Array(body as ArrayBuffer));
		}

		if (navigator.userAgent.includes('gecko')) {
			const http = new XMLHttpRequest();

			http.open('POST', geckoXHR(this.client.url), false);
			http.send(JSON.stringify(data));

			return createResponse(JSON.parse(http.responseText));
		}

		const id = 'sync-request-' + Math.random().toString(16).slice(2);

		const payload = JSON.stringify({
			id,
			data,
		});
		const bytes = byteLength(payload, BEACON_QUOTA);
		if (budget !== undefined && inflight + bytes > budget) return null;

		// a beacon is refused (and never sent) when the payload is over the
		// browser's 64 KiB beacon quota, which a large localStorage value hits;
		// spinning for an answer that cannot come would freeze the page
		if (!navigator.sendBeacon(queueXHR(this.client.url), payload)) {
			if (budget !== undefined) return null;
			throw new DOMException(
				`The synchronous bridge cannot carry this request to ${url} (beacon refused, likely over the 64 KiB payload limit)`,
				'QuotaExceededError',
			);
		}
		inflight += bytes;
		nativeSetTimeout(() => {
			inflight -= bytes;
		}, RELEASE_MS);

		const timeout = limit ?? (loopback ? LOOPBACK_TIMEOUT : TIMEOUT);
		const deadline = Date.now() + timeout;
		// an answer this late may be one that cannot come: the controller is
		// told once (see kick)
		let kickAt = Date.now() + SYNC_KICK_MS;

		for (let cycles = 0; Date.now() < deadline; cycles++) {
			if (cycles % 3 !== 0) continue;

			// a piece missing would leave a cut answer, whose last escape decodes
			// to a control character: wait for the whole of it
			const answer = joinAnswer(readCookies(), id);
			if (!answer) {
				if (kickAt && Date.now() >= kickAt) {
					kickAt = 0;
					kick(this.client.global as unknown as Window, this.client.directory);
				}
				continue;
			}

			// same attributes as the service worker set, or a cross-site frame
			// cannot delete them and they pile up until the next request to the
			// proxy origin fails with 431
			for (const cookieName of answer.names) {
				writeCookie(
					`${cookieName}=; path=/; expires=${new Date(0)}; SameSite=None; Secure`,
				);
			}

			return createResponse(JSON.parse(decodeCookie(answer.value)));
		}

		throw new RangeError(
			`Reached the ${timeout} ms limit when requesting ${url}`,
		);
	}
}
