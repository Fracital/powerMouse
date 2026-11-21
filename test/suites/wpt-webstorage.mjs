// web-platform-tests webstorage/ (test/wpt/webstorage): localStorage and
// sessionStorage through the proxy's per-origin stores (the Storage
// interface, the quota, storage events between the frames of an origin),
// measured against the native run. One page at a time: every test shares
// the origin's two stores.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-webstorage', {
	roots: ['webstorage'],
	// each page in a browser context of its own, as each of the two
	// loading at once is (its jar and storage its own)
	concurrency: 2,
	skip: [
		// filling a store until setItem throws, and again after a clear(),
		// crashes the proxied tab, and every page after it in the run with it
		// (the backlog of the wpt-gaps-workers stream has the row)
		/^\/webstorage\/storage_(local|session)_setitem_quotaexceedederr\./,
		/^\/webstorage\/storage_(local|session)_quota_independent_from_(local|session)\./,
	],
});
