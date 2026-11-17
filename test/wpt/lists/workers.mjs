// web-platform-tests workers/: what test/wpt/refresh.mjs copies for the
// wpt-workers-* suites. The tests of everything a proxy stands between a
// page and its workers for: the constructors (URL resolution, same-origin
// checks, blob: and data: URLs, name, type), importScripts, WorkerLocation,
// WorkerNavigator, error events (file name, line, message), the base URL of
// a worker's own requests, script decoding, and module workers.
export const sparse = ['workers', 'common', 'service-workers/service-worker'];

export const include = [
	'common/get-host-info.sub.js',
	'common/utils.js',
	'common/dispatcher/dispatcher.js',
	// the data: URL context tests borrow the service worker tests' frame
	// helpers
	'service-workers/service-worker/resources/test-helpers.sub.js',
	// the top-level tests and the scripts they share
	/^workers\/[^/]+\.(html?|js|headers)$/,
	/^workers\/(support|resources)\/[^/]+$/,
	/^workers\/constructors\/.*$/,
	/^workers\/baseurl\/.*$/,
	/^workers\/multi-globals\/.*$/,
	/^workers\/interfaces\/(DedicatedWorkerGlobalScope|SharedWorkerGlobalScope|WorkerGlobalScope|WorkerUtils)\/.*$/,
	/^workers\/semantics\/(encodings|multiple-workers|navigation|reporting-errors|run-a-worker|xhr)\/.*$/,
	/^workers\/modules\/.*$/,
];

export const exclude = [
	/\/WEB_FEATURES\.yml$/,
	// an origin trial behind a flag
	/^workers\/SharedWorker-extendedLifetime/,
	// third-party partitioning: several registrable domains over https
	/^workers\/shared-worker-partitioned/,
	/^workers\/support\/(shared-worker-partitioned|shared-worker-echo-cookies)/,
	// structured clone of image data: nothing a proxy stands in the way of
	/^workers\/interfaces\/DedicatedWorkerGlobalScope\/postMessage\/(imagedata-cloned-canvas-in-array|structured-clone-imagedata)\./,
	// spins the main thread on a SharedArrayBuffer until a worker answers:
	// natively it never ends in the runner's tab, which then cannot be
	// navigated away
	/^workers\/postMessage_block\.https\.html/,
	/^workers\/support\/postMessage_block_worker\.js/,
	// time out natively (20 s each): a data: URL shared worker in a frame of
	// another site, an error event a shared worker never gets
	'workers/SharedWorker_dataUrl.html',
	'workers/support/iframe_sw_dataUrl.html',
	'workers/shared-worker-runtime-error-is-not-parse-error.html',
];
