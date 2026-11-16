// A worker's connect-src judges its WebSockets and WebTransport sessions as
// natively (test/csp-server.mjs `js=worker`, test/pages/csp-worker-probes.js,
// test/pages/csp-worker.js). No service worker sees a WebSocket or a
// session, so the inject judges them: in a document by the document's
// policies (csp-hosts), in a worker by the worker's own, which natively are
// the policies of its script's response (a dedicated, module, shared or
// service worker of a URL) or its creator's (a blob: or data: worker),
// never the document's for a worker of a URL. A refused socket fires error
// and no close, a refused session's `ready` and `closed` reject with
// Chrome's WebTransportError, and the worker's global gets Chrome's
// securitypolicyviolation event (trusted, the worker's URL as its
// documentURI, `blob` or `data` for one of those, status 0), once per
// policy that refuses, report-only ones included. The document hears
// nothing of a worker's. Each worker answers with what each connection did
// and the events its global saw; compared with the page loaded natively,
// in both modes.
//
// Nothing listens for QUIC at the sessions' URLs: a session the policy
// lets go out fails (natively and through the proxy) some other way, which
// the probes do not tell apart; what is compared is whether it was refused,
// and how.
import { compareCases } from '../csp-lib.mjs';
import { done, launch, ok } from '../lib.mjs';

const SELF = "connect-src 'self'";

const CASES = {
	"the worker's own policy": {
		js: 'worker',
		probes: [
			'w-dedicated-plain',
			'w-dedicated-connect',
			'w-dedicated-default',
			'w-dedicated-none',
			'w-module-connect',
			'w-shared-connect',
			'w-service-connect',
		],
	},
	"the worker's own report-only policy": {
		js: 'worker',
		probes: [
			'w-dedicated-ro',
			'w-dedicated-connect-ro',
			'w-module-ro',
			'w-shared-ro',
			'w-service-ro',
		],
	},
	"the document's policy": {
		js: 'worker',
		p: SELF,
		probes: [
			'ws-self',
			'ws-other',
			'wt-self',
			'wt-other',
			'w-dedicated-plain',
			'w-dedicated-none',
			'w-module-plain',
			'w-shared-plain',
			'w-service-plain',
			'w-blob-plain',
			'w-blob-module-plain',
			'w-shared-blob-plain',
			'w-data-plain',
		],
	},
	"the document's report-only policy": {
		js: 'worker',
		ro: SELF,
		probes: [
			'ws-other',
			'wt-other',
			'w-dedicated-plain',
			'w-blob-plain',
			'w-data-plain',
		],
	},
	"the document's default-src": {
		js: 'worker',
		p: "default-src 'self'; worker-src 'self' blob: data:",
		probes: ['wt-other', 'w-dedicated-plain', 'w-blob-plain', 'w-data-plain'],
	},
	"the document's meta": {
		js: 'worker',
		m: SELF,
		probes: ['ws-other', 'w-dedicated-plain', 'w-blob-plain'],
	},
};

const browser = await launch();
const native = await compareCases(browser, CASES);
// what the comparison rests on, natively
const own = native["the worker's own policy"]?.results ?? {};
ok(
	"natively, a worker's own connect-src refuses its socket and its session, and its global hears of both",
	/localhost:\d+ ws: error 3"/.test(own['w-dedicated-connect']) &&
		/localhost:\d+ wt: refused WebTransportError/.test(
			own['w-dedicated-connect'],
		) &&
		(own['w-dedicated-connect'].match(/isTrusted\\":true/g) ?? []).length === 2,
	own['w-dedicated-connect'],
);
const document = native["the document's policy"]?.results ?? {};
ok(
	"natively, a worker of a URL is not under its document's policy, a blob: or data: worker is",
	!/error 3/.test(document['w-dedicated-plain']) &&
		/localhost:\d+ ws: error 3"/.test(document['w-blob-plain']) &&
		/localhost:\d+ ws: error 3"/.test(document['w-data-plain']),
	JSON.stringify(document),
);
await done(browser);
