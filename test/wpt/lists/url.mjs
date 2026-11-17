// web-platform-tests url/: the URL and URLSearchParams interfaces behind the
// proxy's hooked constructors, and the same parser reached through anchors,
// areas, <base>, navigation, fetch, XHR and sendBeacon.
export const sparse = ['url', 'common'];

export const include = [
	// every test of the directory with the JSON data it reads
	/^url\/[^/]+\.(js|html|xhtml)$/,
	/^url\/resources\/[^/]+\.(js|json)$/,
	'common/subset-tests-by-key.js',
];

export const exclude = [
	// needs /resources/WebIDLParser.js, which is resources/webidl2/lib/ upstream:
	// refresh.mjs cannot wipe a directory under resources/ yet
	'url/idlharness.any.js',
];
