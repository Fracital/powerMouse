// web-platform-tests the-script-element/module
// (test/wpt/html/semantics/scripting-1): module scripts, their fetches,
// errors and order, dynamic import, import.meta and top-level await,
// measured against the native run.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-modules', {
	roots: ['html/semantics/scripting-1/the-script-element/module'],
	concurrency: 2,
});
