// web-platform-tests webstorage/: what test/wpt/refresh.mjs copies for the
// wpt-webstorage suite. The top-level localStorage and sessionStorage tests:
// the Storage interface (set, get, remove, clear, key, length, enumeration,
// the named properties), the quota, and storage events between the frames
// of an origin.
export const sparse = ['webstorage', 'common'];

export const include = [
	'common/get-host-info.sub.js',
	/^webstorage\/[^/]+\.(html|js)$/,
	/^webstorage\/resources\/[^/]+\.html$/,
];

export const exclude = [
	/^webstorage\/[^/]+-manual\.html$/,
	// third-party storage partitioning: several registrable domains
	/^webstorage\/.*partitioned/,
	// needs the dispatcher's python stash and the credentialless frame helpers
	'webstorage/localstorage-cross-origin-iframe.https.window.js',
];
