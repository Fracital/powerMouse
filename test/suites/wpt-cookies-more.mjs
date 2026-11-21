// web-platform-tests cookies/ (test/wpt/cookies), the directories the
// wpt-cookies suite leaves out: SameSite on fetches, frames, forms, images
// and popups, same-site and across sites, SameSite=None without Secure, and
// the Domain attribute, measured against the native run. The proxy computes
// each of these itself: to the browser every proxied request is same-site.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-cookies-more', {
	roots: ['cookies/samesite', 'cookies/samesite-none-secure', 'cookies/domain'],
	// each page in a browser context of its own, as each of the two
	// loading at once is (its jar and storage its own)
	concurrency: 2,
	skip: [
		// natively it posts no report within the budget on the fixture (two
		// recorded runs): 30 s in each mode for nothing compared
		/^\/cookies\/samesite\/iframe-reload\.https\.html/,
	],
});
