// eventsource: every test of the directory (window, the worker variants of
// the .any.js ones, the hand-written dedicated-worker/ and shared-worker/
// pages) and the static resources they load. The python handlers are ported
// in test/wpt-handlers/eventsource.mjs.
export const sparse = ['eventsource', 'common'];

export const include = [
	/^eventsource\/[^/]+\.(any|window)\.js$/,
	/^eventsource\/[^/]+\.htm$/,
	/^eventsource\/(dedicated-worker|shared-worker)\/[^/]+\.(js|htm)$/,
	/^eventsource\/resources\/[^/]+\.(htm|event_stream)$/,
	'common/get-host-info.sub.js',
];

export const exclude = [];
