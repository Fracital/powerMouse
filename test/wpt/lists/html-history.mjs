// html/browsers/history: the History and Location interfaces (the
// wpt-history and wpt-location suites). The pages a human has to drive
// (non-automated/, *-manual.html) stay out.
export const sparse = ['html/browsers/history', 'images', 'common'];

export const include = [
	/^html\/browsers\/history\/the-(history|location)-interface\/.*\.(html?|js)$/,
	'common/test-setting-immutable-prototype.js',
	'common/stringifiers.js',
	'common/object-association.js',
	'common/domain-setter.sub.html',
	'resources/blank.html',
	'images/smiley.png',
];

export const exclude = [
	/^html\/browsers\/history\/the-(history|location)-interface\/non-automated\//,
	/^html\/browsers\/history\/.*-manual\.html?$/,
	// Chrome reaches no rate limit in them: each fails natively after ten
	// seconds
	/^html\/browsers\/history\/the-history-interface\/history_(pushstate|replacestate)_too_many_calls/,
	// RemoteContextHelper windows: popups behind the dispatcher handler
	'html/browsers/history/the-history-interface/history-state-after-bfcache.window.js',
	'html/browsers/history/the-history-interface/history_go_zero_which_document.window.js',
];
