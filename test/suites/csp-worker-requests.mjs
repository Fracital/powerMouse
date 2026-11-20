// A worker's requests are judged by the worker's own policy as natively
// (test/csp-server.mjs `js=worker`, test/pages/csp-worker-probes.js'
// `r-*` and `n-*` probes, test/pages/csp-worker.js): its fetches, its
// XMLHttpRequests (async and sync), its EventSources, importScripts and
// import(), and its own workers' connections. Natively a dedicated,
// module, shared or service worker of a URL has the policies of its
// script's response, a blob: or data: worker its creator's (csp-workers),
// and a refusal fails as the browser fails it: fetch rejects with
// "TypeError: Failed to fetch", an XMLHttpRequest fires error (a sync one
// throws NetworkError), an EventSource fires error and is closed,
// importScripts throws NetworkError, import() rejects. The worker's global
// gets Chrome's securitypolicyviolation for each (two for a fetch or an
// importScripts a report-only policy refuses), and a policy's report-uri
// gets its report. Each worker answers with what each request did and the
// events its global saw, and which of the requests (and reports) reached
// the fixture; compared with the page loaded natively, in both modes.
// (A `data:` worker does not run through the proxy at all: none here.)
import { compareCases } from '../csp-lib.mjs';
import { done, launch, ok } from '../lib.mjs';

const SELF = "connect-src 'self'";

const CASES = {
	"the worker's own policy": {
		js: 'worker',
		probes: [
			'r-dedicated-plain',
			'r-dedicated-connect',
			'r-dedicated-default',
			'r-dedicated-script',
			'r-module-connect',
			'r-module-default',
			'r-shared-connect',
			'r-shared-default',
			'r-service-connect',
			'r-service-default',
		],
	},
	"the worker's own report-only policy": {
		js: 'worker',
		probes: [
			'r-dedicated-ro',
			'r-dedicated-default-ro',
			'r-module-ro',
			'r-shared-ro',
			'r-service-ro',
		],
	},
	"the worker's own policy's report-uri": {
		js: 'worker',
		probes: ['r-dedicated-report', 'r-dedicated-report-ro', 'r-shared-report'],
	},
	"a redirect the worker's own policy refuses": {
		js: 'worker',
		probes: ['h-dedicated-plain', 'h-dedicated-connect', 'h-dedicated-ro'],
	},
	"a module worker's static imports": {
		js: 'worker',
		probes: ['r-module-plain-si', 'r-module-default-si'],
	},
	"a worker's own workers": {
		js: 'worker',
		probes: [
			'n-dedicated-plain',
			'n-dedicated-connect',
			'n-dedicated-worker-none',
		],
	},
	"the document's policy": {
		js: 'worker',
		p: SELF,
		probes: [
			'r-dedicated-plain',
			'r-blob-plain',
			'r-blob-module-plain',
			'r-shared-blob-plain',
		],
	},
	"the document's report-only policy": {
		js: 'worker',
		ro: "default-src 'self'; script-src * 'unsafe-inline'",
		probes: ['r-blob-plain'],
	},
	"the document's script-src": {
		js: 'worker',
		p: "script-src 'self' 'unsafe-inline'; worker-src 'self' blob: data:",
		probes: ['r-blob-plain', 'r-module-plain-si'],
	},
};

// each listed in docs/csp.md
const NO_HOP_VIOLATION =
	"the hop the worker's policy refuses is refused (the service worker answers a network error, and the fetch rejects as natively) or let out, but its violation is not fired: the service worker cannot reach the worker's global";
const BLOB_IMPORT_PLACE =
	"a blob: worker's import() violation names the column the rewrite of the call maps to, natively its specifier's";
const EXPECTED = {
	"the document's script-src": { 'r-blob-plain': BLOB_IMPORT_PLACE },
	"a redirect the worker's own policy refuses": {
		'h-dedicated-connect': NO_HOP_VIOLATION,
		'h-dedicated-ro': NO_HOP_VIOLATION,
	},
};

const browser = await launch();
const native = await compareCases(browser, CASES, { expected: EXPECTED });
// what the comparison rests on, natively
const own = native["the worker's own policy"]?.results ?? {};
ok(
	"natively, a worker's own connect-src refuses its fetch, XMLHttpRequest and EventSource, and its global hears of each",
	/localhost\/csp\/ok\?k=[^"]*: rejected TypeError: Failed to fetch/.test(
		own['r-dedicated-connect'],
	) &&
		/xhr localhost[^"]*: loadstart 1 0, error 4 0, loadend 4 0/.test(
			own['r-dedicated-connect'],
		) &&
		/es localhost[^"]*: error 2"/.test(own['r-dedicated-connect']) &&
		(own['r-dedicated-connect'].match(/isTrusted\\":true/g) ?? []).length === 5,
	own['r-dedicated-connect'],
);
const hops =
	native["a redirect the worker's own policy refuses"]?.results ?? {};
ok(
	"natively, a redirect's hop the worker's own connect-src refuses fails the fetch, and its global hears of it by the first URL",
	/rejected TypeError: Failed to fetch/.test(hops['h-dedicated-connect']) &&
		/blockedURI\\":\\"http:\/\/127\.0\.0\.1:\d+\/csp\/to\?/.test(
			hops['h-dedicated-connect'],
		),
	hops['h-dedicated-connect'],
);
const reports = native["the worker's own policy's report-uri"]?.results ?? {};
ok(
	"natively, a worker's own policy's report-uri gets a report of its refusals",
	/reached [^"]*\/csp\/report/.test(reports['r-dedicated-report']),
	reports['r-dedicated-report'],
);
await done(browser);
