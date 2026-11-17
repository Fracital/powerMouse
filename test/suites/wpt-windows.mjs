// web-platform-tests html/browsers/windows (test/wpt/html/browsers/windows):
// nested browsing contexts, browsing context names, opener, parent, top and
// frameElement, measured against the native run.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-windows', {
	roots: ['html/browsers/windows'],
	concurrency: 2,
});
