// web-platform-tests html/semantics/scripting-1/the-script-element
// (test/wpt/html/semantics/scripting-1): the tests of the directory itself
// with fetch-src/ and microtasks/, which script runs, when, and what its
// load and error events say, measured against the native run. The
// execution-timing and module directories have suites of their own.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-script-element', {
	roots: ['html/semantics/scripting-1/the-script-element'],
	concurrency: 2,
	skip: [/\/the-script-element\/(execution-timing|module)\//],
});
