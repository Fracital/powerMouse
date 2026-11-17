// fetch/api: fetch(), Headers, Request and Response as a page and a worker
// see them (basic, cors, credentials, redirect, headers, request, response,
// abort). test/wpt/README.md says why each exclusion is one.
export const sparse = ['fetch/api', 'xhr/resources', 'common', 'images'];

const DIRS = '(basic|cors|credentials|redirect|headers|request|response|abort)';

export const include = [
	new RegExp(`^fetch/api/${DIRS}/[^/]+\\.(html|js)$`),
	/^fetch\/api\/(request|response)\/multi-globals\/.*\.(html|js)$/,
	/^fetch\/api\/cors\/resources\/.*$/,
	'fetch/api/request/resources/hello.txt',
	// what the tests load from fetch/api/resources/ (its python handlers are
	// ported in test/wpt-handlers/fetch-api.mjs)
	/^fetch\/api\/resources\/[^/]+\.(txt|json|html|js)(\.headers)?$/,
	'common/gc.js',
	'images/blue.png',
	// header-value-combining reads these raw responses
	/^xhr\/resources\/(header-content-length(-twice)?|headers-(basic|double-empty|some-are-empty|www-authenticate))\.asis$/,
	'xhr/resources/utf16-bom.json',
];

export const exclude = [
	// HTTP/2 only (wptserve's .h2. handlers)
	/^fetch\/api\/.*\.h2\./,
	// needs wptserve behind a PAC proxy that answers 421 once
	'fetch/api/basic/request-upload-421.any.js',
	// a service worker behind the request
	'fetch/api/abort/serviceworker-intercepted.https.html',
	'fetch/api/request/request-reset-attributes.https.html',
	/^fetch\/api\/resources\/sw-intercept/,
	'fetch/api/resources/basic.html',
	// keepalive requests that outlive their document: iframes on a second
	// site that unload, three seconds of waiting per case
	'fetch/api/basic/keepalive.any.js',
	'fetch/api/cors/cors-keepalive.any.js',
	'fetch/api/abort/keepalive.html',
	'fetch/api/request/request-keepalive-quota.html',
	/^fetch\/api\/redirect\/redirect-keepalive\./,
	/^fetch\/api\/resources\/keepalive-/,
	// a popup opened without user activation stays blocked in headless runs
	'fetch/api/basic/fetch-in-popup-from-iframe.html',
];
