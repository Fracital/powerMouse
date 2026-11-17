// web-platform-tests content-security-policy/: what a page's own policy
// refuses of its connections (connect-src), of javascript: navigations, of
// form submissions (form-action) and of frames (frame-src), with the
// securitypolicyviolation events it fires.
export const sparse = ['content-security-policy', 'common'];

const DIRS = '(connect-src|navigation|form-action|frame-src)';

export const include = [
	new RegExp(
		`^content-security-policy/${DIRS}/[^/]+\\.(html|js)(\\.(sub\\.)?headers)?$`,
	),
	new RegExp(`^content-security-policy/${DIRS}/(support|resources)/[^/]+$`),
	// the helpers and payloads of support/ these tests name
	/^content-security-policy\/support\/(logTest\.sub\.js|alertAssert\.sub\.js|fail\.asis|fail\.png|fail\.js|postmessage-(pass|fail)\.html|postmessage-pass-to-opener\.html)$/,
	'common/dummy.json',
	'common/text-plain.txt',
];

export const exclude = [
	// a real https origin, WebTransport, a worklet
	/^content-security-policy\/.*\.https\./,
	// what they assert is a report's delivery (checkReport.sub.js reads it
	// back from /reporting/resources/report.py)
	/^content-security-policy\/navigation\/javascript-url-navigation-to-[a-z-]+-evaluated-to-string-inherits-csp\.html$/,
	/^content-security-policy\/navigation\/support\/(doc-with-csp-frame-src-none-and-report-uri|test_csp_self_window)\.sub\.html/,
	// drives a frame of another host through /common/dispatcher/, a stash
	// server of its own
	'content-security-policy/frame-src/frame-src-cross-origin-same-document-navigation.window.js',
];
