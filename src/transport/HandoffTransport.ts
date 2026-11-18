// The service worker's side of one controller registration's transport.
// Another controller can take the address while requests are in flight on
// it (the same id given again: a host that keeps one id for every tab, a
// reload that kept its id), and the registration it replaced is closed at
// once, so a request still waiting there would never be answered. Such a
// request was a failed fetch for the page and, for a navigation, the host's
// error page (502, "Controller replaced"). A request that cannot have done
// anything on the server a second time, a GET, HEAD or OPTIONS without a
// body (what Chrome sends again itself when a reused connection closes
// under it, RevivingTransport), is sent again through the controller that
// has the address now; anything else fails as before.
//
// A controller that shakes hands again with the worker that has it is not
// another controller: that registration is let go only once what is in
// flight on it has its answer (`settled`, drainController in
// src/server/serviceWorker.ts), or after a bound, past which such a request
// is sent again through the new channel the same way.
import type {
	ProxyTransport,
	RawHeaders,
	TransferrableResponse,
	WebSocketDataType,
} from '@mercuryworkshop/proxy-transports';
import type RemoteTransport from './RemoteTransport';

/** the reason a registration another controller took the address of is closed with */
export const CONTROLLER_REPLACED = 'Controller replaced';
/** and one its own controller left that was still answering after the bound for it */
export const CONTROLLER_RETIRED = 'Controller retired';
/** the closes a request is sent again after: a controller has the address over another channel */
const HANDED_OVER = new Set([CONTROLLER_REPLACED, CONTROLLER_RETIRED]);

/** sent again through the new controller: no body, and nothing a second request changes */
const REPLAYABLE = new Set(['GET', 'HEAD', 'OPTIONS']);

export default class HandoffTransport implements ProxyTransport {
	/** requests and connects waiting for their answer on this registration's port */
	#inFlight = 0;
	constructor(
		readonly remote: RemoteTransport,
		/** the transport of the controller that took the address, when one did and can take this request */
		private successor: () => Promise<ProxyTransport | undefined>,
	) {}
	get ready() {
		return this.remote.ready;
	}
	set ready(value: boolean) {
		this.remote.ready = value;
	}
	init() {
		return this.remote.init();
	}
	/** fail every pending and later call with `reason` and close the port */
	close(reason: string) {
		this.remote.close(reason);
	}
	/** resolves once nothing waits for an answer on this registration's port, looked at every `ms` */
	async settled(ms = 50): Promise<void> {
		while (this.#inFlight) await new Promise((wake) => setTimeout(wake, ms));
	}
	/** (socketPool.ts) wherever the request went */
	requeue(id: string, op: 'cancel' | 'raise') {
		this.remote.requeue(id, op);
		this.#handedTo?.requeue?.(id, op);
	}
	#handedTo?: ProxyTransport & {
		requeue?: (id: string, op: 'cancel' | 'raise') => void;
	};
	async request(
		remote: URL,
		method: string,
		body: BodyInit | null,
		headers: RawHeaders,
		signal: AbortSignal | undefined,
	): Promise<TransferrableResponse> {
		this.#inFlight++;
		try {
			return await this.remote.request(remote, method, body, headers, signal);
		} catch (error) {
			if (
				!HANDED_OVER.has((error as Error)?.message) ||
				!REPLAYABLE.has(method.toUpperCase()) ||
				(body !== null && body !== undefined)
			)
				throw error;
			const next = await this.successor();
			if (!next) throw error;
			this.#handedTo = next;
			if (!next.ready) await next.init();
			return await next.request(remote, method, body, headers, signal);
		} finally {
			this.#inFlight--;
		}
	}
	connect(
		url: URL,
		protocols: string[],
		requestHeaders: RawHeaders,
		onopen: (protocol: string, extensions: string) => void,
		onmessage: (data: WebSocketDataType) => void,
		onclose: (code: number, reason: string) => void,
		onerror: (error: string) => void,
	): [
		(data: WebSocketDataType) => void,
		(code: number, reason: string) => void,
	] {
		this.#inFlight++;
		let waiting = true;
		const answered = () => {
			if (!waiting) return;
			waiting = false;
			this.#inFlight--;
		};
		return this.remote.connect(
			url,
			protocols,
			requestHeaders,
			(protocol, extensions) => {
				answered();
				onopen(protocol, extensions);
			},
			onmessage,
			(code, reason) => {
				answered();
				onclose(code, reason);
			},
			(error) => {
				answered();
				onerror(error);
			},
		);
	}
}
