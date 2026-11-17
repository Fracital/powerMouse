// web-platform-tests html/semantics/scripting-1/the-script-element
// (test/wpt/html/semantics/scripting-1): the tests of the directory itself
// with fetch-src/ and microtasks/, which script runs, when, and what its
// load and error events say, measured against the native run. The
// execution-timing and module directories have suites of their own.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-script-element', {
	roots: ['html/semantics/scripting-1/the-script-element'],
	concurrency: 2,
	skip: [
		/\/the-script-element\/(execution-timing|module)\//,
		// proxied, its verdict flips from run to run: an XHTML document is
		// re-created through the hooks, where an inline script runs before
		// the external testharness.js ahead of it has loaded (the XML parser
		// waits for it), so the page passes or reports nothing depending on
		// which arrives first (README, XHTML scripts)
		/\/script-type-and-language-js-xhtml\.xhtml$/,
	],
});
