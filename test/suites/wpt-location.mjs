// web-platform-tests html/browsers/history/the-location-interface
// (test/wpt/html/browsers/history): the Location setters, assign, replace,
// reload and the cross-origin checks through the inject's Location module,
// measured against the native run.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-location', {
	roots: ['html/browsers/history/the-location-interface'],
	concurrency: 2,
});
