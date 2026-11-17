// web-platform-tests cookies/, the directories the first suite left out
// that the fixture's hosts can run (wpt-cookies-more): SameSite over every
// kind of request and navigation, SameSite=None without Secure, and the
// Domain attribute.
export const sparse = ['cookies'];

export const include = [
	/^cookies\/samesite\/[^/]+\.html$/,
	/^cookies\/samesite\/resources\/[^/]+\.html$/,
	/^cookies\/samesite-none-secure\/[^/]+\.html$/,
	/^cookies\/domain\/[^/]+\.html(\.(sub\.)?headers)?$/,
];

export const exclude = [
	// asks WebDriver for the jar (test_driver.get_all_cookies and
	// get_named_cookie), which the vendored testdriver has not
	/^cookies\/samesite\/get_(all_cookies|named_cookie)-default-samesite\.html$/,
	// an IDN host of its own, set up by a python handler
	/^cookies\/domain\/domain-attribute-idn-host\./,
];
