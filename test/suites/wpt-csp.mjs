// web-platform-tests content-security-policy/ (test/wpt/content-security-policy):
// connect-src, the javascript: navigations a policy refuses, form-action
// and frame-src, with the violation events the page hears, measured against
// the native run. The proxy enforces a page's policy itself (the browser
// sees every proxied URL as the proxy's own origin), so each of these is the
// inject's or the worker's answer against Chrome's.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-csp', {
	roots: ['content-security-policy'],
	concurrency: 2,
	skip: [
		// their subtests fail natively on Chrome 152 (no text module imports;
		// frame-src-redirect's one subtest times out), two of them after the
		// whole budget: nothing of them is compared
		/^\/content-security-policy\/connect-src\/connect-src-text-import-/,
		/^\/content-security-policy\/frame-src\/frame-src-redirect\.html/,
	],
});
