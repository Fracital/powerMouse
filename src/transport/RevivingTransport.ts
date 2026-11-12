// A transport that comes back after its wisp connection is lost. Epoxy
// never does: when the WebSocket under its wisp multiplexor goes away (a
// port forward, a proxy or a flaky network that drops it), the client keeps
// the dead multiplexor as its connection and its HTTP pool keeps the
// connections that ran over it. A request that needs a new stream fails at
// once with MuxTaskEnded, and one handed a pooled connection over the dead
// multiplexor can wait forever, for the life of the page. Measured: one
// drop 1.5 s into a YouTube load left the page half drawn (the app's
// scripts failed, nothing after the drop loaded) until the host page was
// reloaded.
//
// This wrapper builds a new transport (a new wisp connection and an empty
// pool) the first time a request reports the old connection gone, and sends
// again the requests that cannot have reached the server or that Chrome
// would send again itself: one whose connection was lost while it was being
// opened (its stream or its TLS handshake), and a GET, HEAD or OPTIONS
// without a body that lost its connection before the response head (Chrome
// retries those when a reused connection closes under them). Such a request
// still waiting on the old transport when the new one is up is sent again
// too, since nothing will ever answer it there. A response whose body was
// cut off is the page's, as in Chrome.
import type {
	ProxyTransport,
	RawHeaders,
	TransferrableResponse,
} from '@mercuryworkshop/proxy-transports';

/** the wisp connection under the request is gone */
const DEAD =
	/MuxTaskEnded|Multiplexor task ended|WsImplSocketClosed|MuxMessageFailedTo(?:Send|Recv)/;
/** hyper failed before the request went out (opening its connection) */
const UNSENT = /Error\(Connect,/;
/** the connection closed under a request before its response head */
const LOST =
	/SendRequest|IncompleteMessage|BrokenPipe|broken pipe|connection closed|ConnectionReset|UnexpectedEof/;
/** sent again when their connection is lost, as Chrome does (no body) */
const REPLAYABLE = new Set(['GET', 'HEAD', 'OPTIONS']);
/**
 * A lost connection, a dead multiplexor found on the way, then the new one,
 * with room for a couple of retries against a server throttling a burst
 * (`backoff` spaces those out).
 */
const ATTEMPTS = 5;

/** how long to wait before trying a throttled request again, growing per attempt (ms) */
const BACKOFF_MS = [50, 120, 250, 500];

/** wait out a throttled retry, resolving early if the request is aborted */
function backoff(
	attempt: number,
	signal: AbortSignal | undefined,
): Promise<void> {
	const ms = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1];
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener('abort', done, { once: true });
	});
}

/** whether `error` says the transport's wisp connection is gone */
export const wispGone = (error: unknown): boolean =>
	DEAD.test(String((error as Error)?.message ?? error));

/** a replayable request waiting for its response head */
interface Waiting {
	generation: number;
	/** give up on this attempt: a new wisp connection is open */
	supersede: () => void;
}

const SUPERSEDED = Symbol('superseded');

export default class RevivingTransport implements ProxyTransport {
	#make: () => ProxyTransport;
	#base: ProxyTransport;
	/** bumped each time a new transport replaced the old one */
	#generation = 0;
	#reviving: Promise<boolean> | null = null;
	#waiting = new Set<Waiting>();

	/** `make` builds the transport, and builds it again when its connection is lost */
	constructor(make: () => ProxyTransport) {
		this.#make = make;
		this.#base = make();
	}

	/** the transport in use */
	get base(): ProxyTransport {
		return this.#base;
	}

	get ready(): boolean {
		return this.base.ready;
	}
	set ready(value: boolean) {
		this.base.ready = value;
	}

	/** the base transport's client: Http3Transport opens UDP streams on it */
	get client(): unknown {
		return (this.base as { client?: unknown }).client;
	}

	/** what the base sends of the request fields (serveTransport's fitHeaders) */
	get fieldSupport(): unknown {
		return (this.base as { fieldSupport?: unknown }).fieldSupport;
	}

	init(): Promise<void> {
		return this.base.init();
	}

	async meta(): Promise<void> {
		await (this.base as { meta?: () => Promise<void> }).meta?.();
	}

	connect(...args: Parameters<ProxyTransport['connect']>) {
		const [url, protocols, headers, onopen, onmessage, onclose, onerror] = args;
		const generation = this.#generation;
		// the socket is the page's to open again; the next one should find a
		// live connection
		return this.base.connect(
			url,
			protocols,
			headers,
			onopen,
			onmessage,
			onclose,
			(error) => {
				if (wispGone(error)) void this.revive(generation);
				onerror(error);
			},
		);
	}

	async request(
		remote: URL,
		method: string,
		body: BodyInit | null,
		headers: RawHeaders,
		signal: AbortSignal | undefined,
	): Promise<TransferrableResponse> {
		// a stream body may be read already; nothing else is consumed by trying
		const resendable = !(body instanceof ReadableStream);
		const replayable =
			REPLAYABLE.has(method.toUpperCase()) &&
			(body === null || body === undefined);
		for (let attempt = 1; ; attempt++) {
			const generation = this.#generation;
			const pending = this.base.request(remote, method, body, headers, signal);
			let waiting: Waiting | null = null;
			const superseded = replayable
				? new Promise<typeof SUPERSEDED>((resolve) => {
						waiting = { generation, supersede: () => resolve(SUPERSEDED) };
						this.#waiting.add(waiting);
					})
				: null;
			try {
				const result = superseded
					? await Promise.race([pending, superseded])
					: await pending;
				if (result !== SUPERSEDED) return result;
				// an answer that comes after all is not wanted
				pending.then(
					(late) => cancelBody(late),
					() => {},
				);
				if (attempt >= ATTEMPTS || signal?.aborted)
					throw new Error(
						'Stomp: the wisp connection was lost under the request',
					);
			} catch (error) {
				if (attempt >= ATTEMPTS || signal?.aborted) throw error;
				const message = String((error as Error)?.message ?? error);
				const gone = wispGone(error);
				if (!gone && !LOST.test(message)) throw error;
				if (gone && !(await this.revive(generation))) throw error;
				if (!(UNSENT.test(message) && resendable) && !replayable) throw error;
				// The connection is still up and the request never went out (a wisp
				// server throttling a burst refuses the extra streams: the stream, and
				// so epoxy's TLS over it, ends before the request is sent). Trying again
				// at once only meets the same full window, so back off a little first and
				// let the streams ahead of it finish. A revived request already waited
				// for the new transport's init, so it is not held up again here.
				if (!gone) await backoff(attempt, signal);
			} finally {
				if (waiting) this.#waiting.delete(waiting);
			}
		}
	}

	/**
	 * Build a new transport, unless one was built since `generation` (the
	 * transport a request failed on). Resolves false when the new one could
	 * not start; the next failure tries again.
	 */
	revive(generation: number): Promise<boolean> {
		if (generation !== this.#generation) return Promise.resolve(true);
		this.#reviving ??= (async () => {
			try {
				const next = this.#make();
				await next.init();
				this.#base = next;
			} catch (error) {
				console.warn(
					'Stomp: the wisp connection was lost and a new transport could not start:',
					error,
				);
				return false;
			}
			this.#generation++;
			console.warn(
				'Stomp: the wisp connection was lost; a new transport takes over',
			);
			for (const waiting of this.#waiting)
				if (waiting.generation < this.#generation) waiting.supersede();
			return true;
		})().finally(() => {
			this.#reviving = null;
		});
		return this.#reviving;
	}
}

function cancelBody(response: TransferrableResponse) {
	const body = response.body as unknown;
	if (body instanceof ReadableStream) body.cancel().catch(() => {});
}
