import Client from '../Client';
import Module from '../Module';
import { webTransportParts } from '../webTransportParts';
import type { standIn } from '../webTransportStandIn';
import ProxyModule from './Proxy';

/*
 * WebTransport (docs/webtransport.md). The browser's own WebTransport opens
 * a QUIC connection from the network service, from the user's address, to
 * whatever server a page names: nothing of the proxy is in its path. So a
 * page never gets the browser's constructor. `WebTransport` is a stand-in
 * that reads as the browser's (the browser's own prototype, with the
 * stand-in as its `constructor`), checks its arguments as the browser does,
 * and makes sessions of STomp's own: ordinary objects on the browser's
 * prototype, whose members are the browser's functions wrapped to answer
 * for a session of ours and to run as they are for anything else.
 *
 * A session's handshake starts when Chrome's own throttle of a page's
 * handshakes would start it, and from there it is carried through the
 * transport (src/transport/webTransportHost.ts: stomp-h3 over a wisp UDP
 * stream) by ../webTransport.ts. One that does not come up ends as the browser's does when its
 * server cannot be reached: `closed` and then `ready` reject with "Opening
 * handshake failed.".
 *
 * A frame that never constructs one pays for the constructor's wrapper and
 * nothing else: the stand-in (../webTransportStandIn.ts) is evaluated, the
 * prototypes wrapped and the other WebTransport interfaces looked at when a
 * realm makes its first session (in a document, a deferred part of the
 * bundle, ../dom/deferred.ts).
 */

// taken as the bundle loads, before a page could replace them (the stand-in,
// ../webTransportStandIn.ts, may be evaluated later: a deferred part)
export const now = Date.now;
export const random = Math.random;
export const later = setTimeout;
export const cancel = clearTimeout;
export const bufferLength = Reflect.getOwnPropertyDescriptor(
	ArrayBuffer.prototype,
	'byteLength',
)!.get!;
export const isView = ArrayBuffer.isView;

export default class WebTransportModule extends Module<Client> {
	apply() {
		const client = this.client;
		const global = client.global as unknown as Record<string, unknown>;
		// (a context that is not secure has none)
		const Native = global.WebTransport as Function | undefined;
		if (typeof Native !== 'function') return;
		const proxyModule = client.getModule(ProxyModule)!;
		let construct: ReturnType<typeof standIn> | undefined;
		// (the stand-in is evaluated with the realm's first session: the
		// document bundle's is a deferred part, ../webTransportParts.ts)
		global.WebTransport = proxyModule.wrapFunction(
			Native,
			(target, that, args, newTarget) =>
				(construct ??= webTransportParts.standIn!()(
					client,
					Native,
					proxyModule,
				))(args, newTarget),
			true,
		);
	}
}
