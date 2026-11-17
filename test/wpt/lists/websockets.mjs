// websockets: the constructor, the opening and closing handshakes, sending
// and receiving text and binary, close codes, bufferedAmount, readyState and
// the event tests. test/wpt/README.md says why each exclusion is one.
export const sparse = ['websockets', 'common'];

export const include = [
	/^websockets\/[^/]+\.(html|js)$/,
	/^websockets\/(binary|closing-handshake|constructor|keeping-connection-open|opening-handshake|security)\/[^/]+\.(html|js)$/,
	/^websockets\/interfaces\/.*\.(html|js)$/,
	/^websockets\/multi-globals\/.*\.html$/,
	'common/utils.js',
	'common/gc.js',
	'common/blank.html',
];

export const exclude = [
	// the IDL harness and the interface files behind it
	'websockets/idlharness.any.js',
	// the back/forward cache, driven through the remote-context helper and a
	// stash dispatcher
	/^websockets\/back-forward-cache-/,
	'websockets/resources/websockets-test-helpers.sub.js',
	// an https page that opens a ws: socket
	'websockets/mixed-content.https.any.js',
	// the fetch stash handlers behind it
	'websockets/remove-own-iframe-during-onerror.window.js',
	// local-network access, a permission prompt
	'websockets/constructor/target-address-space.any.js',
	// the backpressure handlers (a megabyte a message, a sleeping reader)
	'websockets/send-many-64K-messages-with-backpressure.any.js',
];
