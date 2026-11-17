// web-platform-tests dom/nodes (test/wpt/dom/nodes): the insertion,
// removal, cloning and mutation-observer tests, the part the inject's
// insertion hooks can change, measured against the native run.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-dom-insertion', {
	roots: ['dom/nodes'],
	concurrency: 2,
});
