// xhr: the top-level XMLHttpRequest tests (open, send, abort, timeout,
// responseType, response headers, overrideMimeType, the synchronous cases,
// upload events, CORS) and xhr/formdata. test/wpt/README.md says why each
// exclusion is one.
export const sparse = [
	'xhr',
	'fetch/api/resources',
	'html/dom/documents',
	'images',
	'media',
];

export const include = [
	/^xhr\/[^/]+\.(htm|html|js)$/,
	// what the open-url-* tests resolve to from the test's own directory
	'xhr/folder.txt',
	/^xhr\/formdata\/[^/]+\.(html|js)$/,
	/^xhr\/resources\/.*$/,
	'common/get-host-info.sub.js',
	'common/utils.js',
	'common/blank.html',
	// cors-expose-star.sub.any.js
	'fetch/api/resources/utils.js',
	// responsexml-document-properties.htm
	'html/dom/documents/resource-metadata-management/support/document-lastModified-utils.js',
	// formdata/constructor-submitter*.html, submitter-coordinate-value.html
	'media/1x1-green.png',
	'images/100px-green-rect.svg',
];

export const exclude = [
	// the IDL harness and the interface files behind it
	'xhr/idlharness.any.js',
	// HTTP/2 status lines
	'xhr/status.h2.window.js',
	// need a person at the keyboard
	/^xhr\/.*-manual\.htm$/,
	// /permissions-policy/ helpers and an https cross-origin frame
	'xhr/xmlhttprequest-sync-default-permissions-policy.tentative.sub.html',
	// a second http port that refuses the request
	'xhr/security-consideration.sub.html',
	'xhr/resources/img.jpg',
	// /cors/support.js, a directory nothing else here needs
	'xhr/send-conditional-cors.htm',
	// 1.1 MB of "abcd": the handler module writes it instead
	'xhr/resources/over-1-meg.txt',
];

// The xhr tests run as five suites (test/suites/wpt-xhr-*.mjs), each a few
// minutes: a page belongs to the first of these groups its path matches,
// and to `response` when it matches none.
const GROUPS = [
	// each of these waits seconds by design, for a timeout or a slow load
	['timeout', /^\/xhr\/xmlhttprequest-timeout-/],
	[
		'cors',
		/^\/xhr\/(access-control-|cors-|allow-lists-|send-redirect-to-|send-authentication-|send-non-same-origin|open-user-password-|timeout-cors-|event-upload-progress-crossorigin|xhr-authorization-)/,
	],
	[
		'events',
		/^\/xhr\/(abort-|event-|send-(no-)?response-|send-sync-|send-timeout-|send-network-error-|sync-|timeout-|xmlhttprequest-timeout-|xmlhttprequest-sync-|xhr-timeout-|progress|firing-events-|loadstart-|thrown-error-|open-(after|during|send-during)-abort)/,
	],
	[
		'request',
		/^\/xhr\/(open-|send-|setrequestheader-|request-|header-|preserve-ua-|content-type-|formdata|XMLHttpRequest-withCredentials|cookies|data-uri|blob-range)/,
	],
];

/** the suite a test page (path and query) runs in */
export const groupOf = (path) =>
	GROUPS.find(([, pattern]) => pattern.test(path))?.[0] ?? 'response';

/** a suite's `skip` rule: every page of another group */
export const otherThan = (group) => ({
	test: (path) => groupOf(path) !== group,
});

/** pages no xhr suite runs (the README says why for each) */
export const skipped = [
	// time out natively (20 s each): Chrome fires no error event for a
	// request whose frame is removed, and the preflight delay outlasts the
	// harness
	/^\/xhr\/open-url-multi-window-4\.htm$/,
	/^\/xhr\/timeout-multiple-fetches\.html$/,
	// 22 s a variant in each mode: the worker runs every case of the file
	// for each one. The worker's timeouts are measured by the -simple,
	// -twice, -overrides and -synconworker files
	/^\/xhr\/xmlhttprequest-timeout-worker-(aborted|overridesexpires)\.html/,
	// passes or fails proxied from one run to the next, in both globals (some
	// runs the second PUT reads the first one's answer)
	/^\/xhr\/access-control-basic-allow-preflight-cache-timeout\.any\./,
	// natively flaky under load: the load comes after 4 s against a 5 s
	// timeout, and on a busy machine the timeout wins some runs
	/^\/xhr\/xmlhttprequest-timeout-(worker-)?twice\.html\?load fires normally with same timeout set twice$/,
];
