// navigation-api: the Navigation API (the wpt-navigation-api suite, which
// runs it natively and in just call stomp). The pages that need the
// back/forward cache helper or a service worker of their own stay out; the
// python handlers are ported (test/wpt-handlers/navigation-api.mjs).
export const sparse = ['navigation-api'];

export const include = [/^navigation-api\/.*\.(html?|js|mjs|headers)$/];

export const exclude = [
	// RemoteContextHelper and the back/forward cache helper (not vendored)
	/^navigation-api\/.*bfcache/,
	// a service worker of the test's own
	'navigation-api/navigation-methods/reload-service-worker-fetch-event.html',
];

/** the pages both navigation-api suites leave out (README, navigation-api) */
export const NAVIGATION_API_SKIP = [
	// hangs Chrome 157's renderer natively (the blur of a focus reset
	// navigating again), and every page of the origin with it
	/reentry-from-focus-reset-navigate-api-tracker\.html$/,
];
