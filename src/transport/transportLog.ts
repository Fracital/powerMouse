// What the transport tells the host's console, in KrunkNative's manner (its
// client_net_note): one plain line per event, `console.info` for what went
// as it should, `console.warn` for a failure.
// - `[wisp]` notes, always: what the wisp connection is tried on and rides
//   (WebTransport over UDP/QUIC, or the WebSocket over TCP), how long the
//   session took, why WebTransport was not had and when it is tried again,
//   a session or a WebSocket that ended, a reconnect (wispWebTransport.ts,
//   RevivingTransport.ts);
// - `[net]` lines, only in the verbose mode (ControllerInit.debugTransport:
//   the host origin's `localStorage['stomp:debug-transport'] = '1'`, the
//   demo's `?transportdebug`): one per connection the transport opens to a
//   site, what it rides there (HTTP/1.1 or HTTP/2 over a Wisp TCP stream,
//   HTTP/3 over a Wisp UDP stream) and what that Wisp stream rides to the
//   relay, and each time HTTP/3 to an origin falls back and why. While it is
//   off a call site tests `transportLog.on` and builds nothing.
// The notes are made where the transport runs (the transport worker, or the
// controller's page) and printed by the host's controller only: no port a
// proxied page holds carries them.
import type { ProxyTransport } from '@mercuryworkshop/proxy-transports';

/** the verbose mode: whether `[net]` lines are made in this realm (the controller turns it on) */
export const transportLog = { on: false };

/** a line for the host's console */
export interface TransportNote {
	level: 'info' | 'warn';
	text: string;
}

const listeners = new Set<(note: TransportNote) => void>();

/** `listener` hears every note of this realm's transports; returns the unwatch */
export function watchTransportNotes(listener: (note: TransportNote) => void) {
	listeners.add(listener);
	return () => void listeners.delete(listener);
}

function tell(note: TransportNote) {
	for (const listener of listeners)
		try {
			listener(note);
		} catch {
			// a listener's own error
		}
}

/** a `[wisp]` note: what the wisp connection rides */
export const wispNote = (level: TransportNote['level'], text: string) =>
	tell({ level, text: `[wisp] ${text}` });

/** a note made in another realm (the carrier host's), told here as it was made */
export const relayNote = (note: TransportNote) =>
	tell({
		level: note.level === 'warn' ? 'warn' : 'info',
		text: String(note.text),
	});

/** a `[net]` line of the verbose mode (call it only when `transportLog.on`) */
export const logTransport = (text: string) =>
	tell({ level: 'info', text: `[net] ${text}` });

/** what the carrier of a transport's wisp connection is, under its wrappers */
function carrierOf(transport: ProxyTransport): string | null {
	let current: unknown = transport;
	for (let depth = 0; depth < 6 && current; depth++) {
		const carrier = (current as { carrier?: unknown }).carrier;
		if (typeof carrier === 'string') return carrier;
		current = (current as { base?: unknown }).base;
	}
	return null;
}

/**
 * What a Wisp stream of `transport` rides to the relay: a TCP stream's
 * packets go on the session's one QUIC stream, a UDP stream's DATA as
 * datagrams when it fits (wispWebTransport.ts pipeOf)
 */
export function rideOf(transport: ProxyTransport, udp: boolean): string {
	const carrier = carrierOf(transport);
	if (carrier === 'webtransport')
		return udp
			? 'on WebTransport (QUIC datagrams)'
			: "on WebTransport (the session's QUIC stream)";
	return carrier === 'websocket'
		? 'on the WebSocket (TCP)'
		: "on the transport's own connection to its relay";
}

/** an HTTP version as a response names it ("1.1", "2", "3"), as a line reads it */
const versionName = (version: string | undefined) =>
	version ? `HTTP/${version}` : 'HTTP (version not reported)';

/** what an HTTP connection of `version` rides to the server */
const pathOf = (version: string | undefined, secure: boolean) =>
	version === '3'
		? 'QUIC over a Wisp UDP stream'
		: `${secure ? 'TLS over ' : ''}a Wisp TCP stream`;

/**
 * The line of an HTTP connection to `origin`: its protocol, what its Wisp
 * stream rides, and the pool it is in (the network partition, and a
 * request without credentials, which Chrome keeps on connections of their
 * own)
 */
export function connectionLine(
	transport: ProxyTransport,
	version: string | undefined,
	origin: string,
	partition: string,
	credentials: string,
	nth = 1,
): string {
	const pool = [
		partition && `partition ${partition}`,
		credentials === 'anonymous' && 'without credentials',
	].filter(Boolean);
	return `${versionName(version)} to ${origin}${nth > 1 ? `, connection ${nth}` : ''}: ${pathOf(version, origin.startsWith('https:'))}, ${rideOf(transport, version === '3')}${pool.length ? `; ${pool.join(', ')}` : ''}`;
}
