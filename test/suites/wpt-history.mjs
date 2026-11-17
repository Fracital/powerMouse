// web-platform-tests html/browsers/history/the-history-interface
// (test/wpt/html/browsers/history): pushState, replaceState, traversal,
// popstate and hashchange through the inject's History module, measured
// against the native run.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-history', {
	roots: ['html/browsers/history/the-history-interface'],
	concurrency: 2,
});
