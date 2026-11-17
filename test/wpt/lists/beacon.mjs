// beacon: the navigator.sendBeacon tests (payload kinds and sizes, the
// quota, redirects, CORS, the Content-Type, Origin and Referer headers, the
// URL's encoding). The python handlers are ported in
// test/wpt-handlers/beacon.mjs.
export const sparse = ['beacon', 'common'];

export const include = [
	/^beacon\/[^/]+\.https\.(window\.js|html)$/,
	'beacon/beacon-common.sub.js',
	/^beacon\/headers\/[^/]+\.(html|js)$/,
	'common/get-host-info.sub.js',
	'common/utils.js',
	'common/blank.html',
	'common/text-plain.txt',
];

// idlharness.any.js: the interface shape, with the whole IDL tooling behind it
export const exclude = [];
