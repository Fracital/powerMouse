// html/semantics/scripting-1/the-script-element (the wpt-script-element,
// wpt-script-timing and wpt-modules suites) and the document.write tests of
// html/webappapis/dynamic-markup-insertion (wpt-document-write).
export const sparse = [
	'html/semantics/scripting-1',
	'html/webappapis',
	'common',
	'images',
];

const SCRIPT = 'html\\/semantics\\/scripting-1\\/the-script-element';

export const include = [
	// the tests of the directory itself and the small groups beside them
	new RegExp(`^${SCRIPT}\\/[^/]+$`),
	new RegExp(
		`^${SCRIPT}\\/(execution-timing|fetch-src|microtasks|resources|support)\\/.*$`,
	),
	// module scripts: the directory, dynamic import, import.meta and
	// top-level await
	new RegExp(`^${SCRIPT}\\/module\\/.*$`),
	/^html\/webappapis\/dynamic-markup-insertion\/(document-write|document-writeln|closing-the-input-stream)\/.*$/,
	'common/media.js',
	'common/text-plain.txt',
	'images/red.png',
	'images/pattern.mp4',
	'images/pattern.webm',
	'html/webappapis/dynamic-markup-insertion/opening-the-input-stream/resources/dummy.html',
];

export const exclude = [
	/WEB_FEATURES\.yml$/,
	/\/tools\//,
	// time out natively
	`${SCRIPT.replaceAll('\\', '')}/fetch-src/empty-set-while-connected.html`,
	`${SCRIPT.replaceAll('\\', '')}/execution-timing/102.html`,
	// `import defer`, which Chrome does not parse
	new RegExp(
		`^${SCRIPT}\\/module\\/dynamic-import\\/.*deferred?-eval.*\\.tentative\\.html$`,
	),
	// need preload/resources/echo-referrer.py
	new RegExp(`^${SCRIPT}\\/module\\/modulepreload-.*referrer.*\\.html$`),
];
