// html/webappapis/scripting/events (event handler attributes, the
// wpt-event-handlers suite) and
// html/infrastructure/urls/dynamic-changes-to-base-urls (wpt-base-urls).
export const sparse = [
	'html/webappapis',
	'html/infrastructure',
	'interfaces',
	'common',
];

export const include = [
	/^html\/webappapis\/scripting\/events\/.*\.(html?|js)$/,
	/^html\/infrastructure\/urls\/dynamic-changes-to-base-urls\/.*\.(html|xhtml)$/,
	// the event handler tests read the handler names from the HTML IDL
	'resources/webidl2/lib/webidl2.js',
	'interfaces/html.idl',
];

export const exclude = [
	/^html\/webappapis\/scripting\/events\/.*-manual\.html?$/,
	// the window's move event: needs a window manager behind testdriver
	/^html\/webappapis\/scripting\/events\/event-handler-onmove-/,
	// a secure-context page that must fail over http
	'html/webappapis/scripting/events/messageevent-constructor.https.html',
];
