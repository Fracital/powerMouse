// html/browsers/windows: nested browsing contexts, browsing context names,
// opener and frameElement (the wpt-windows suite). The print reference
// tests and the pages a human has to drive stay out.
export const sparse = ['html/browsers/windows', 'common', 'images'];

export const include = [
	/^html\/browsers\/windows\/.*\.(html?|js|txt)$/,
	'common/PrefixedLocalStorage.js',
	'images/green.svg',
];

export const exclude = [
	/^html\/browsers\/windows\/.*-manual\./,
	/^html\/browsers\/windows\/.*print/,
	// a secure-context page that must fail over http
	/^html\/browsers\/windows\/.*\.https\./,
	// times out natively (a sibling frame on a second port)
	'html/browsers/windows/nested-browsing-contexts/frameElement-siblings.sub.html',
	// RemoteContextHelper windows: popups behind the dispatcher handler
	/^html\/browsers\/windows\/auxiliary-browsing-contexts\/(named-lookup-|no-proactive-swap-)/,
	'html/browsers/windows/browsing-context-names/duplicate-name-order.html',
];
