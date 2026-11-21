// Test-only stand-in for the in-browser Tor client's transport
// (demo/public/tor-client/transport.mjs): the demo uses it in Tor mode when
// the server runs with STOMP_TOR_CLIENT=stand-in, which test/run.mjs sets
// for the suites that turn Tor mode on. The suites cannot reach the Tor
// network, and Tor could not reach their fixture, so this is epoxy over the
// demo's own /wisp/: what they check is the page's choice of Tor mode's
// transport, its scope and its profile, not Tor (test/tor-client-smoke.mjs
// runs the real client). It refuses WebSockets as the client does.
import Epoxy from '../epoxy/index.mjs';

export default class TorStandIn extends Epoxy {
	constructor({ wisp } = {}) {
		super({ wisp });
	}

	connect(_url, _protocols, _headers, _onopen, _onmessage, onclose, onerror) {
		queueMicrotask(() => {
			onerror('WebSockets are not available in Tor mode');
			onclose(1006, '');
		});
		return [() => {}, () => {}];
	}
}
