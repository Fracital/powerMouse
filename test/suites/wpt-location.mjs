// web-platform-tests html/browsers/history/the-location-interface
// (test/wpt/html/browsers/history): the Location setters, assign, replace,
// reload and the cross-origin checks through the inject's Location module,
// measured against the native run.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-location', {
	roots: ['html/browsers/history/the-location-interface'],
	concurrency: 2,
	skip: [
		// the proxied verdict flips (TIMEOUT in one or the other in about
		// half the runs, at a020670b as at 5616d7cd; natively always PASS):
		// the page navigates a frame still on its initial about:blank, and
		// the proxied navigation starts only once the service worker heard of
		// its initiator, after the frame's own src has committed, where the
		// native one cancels it (test/wpt/BACKLOG.md, wpt-location)
		/^\/html\/browsers\/history\/the-location-interface\/(assign|replace)-with-nested-iframe\.html/,
	],
});
