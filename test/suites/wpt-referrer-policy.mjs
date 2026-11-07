// web-platform-tests referrer-policy (test/wpt/referrer-policy): the
// Referer the proxy sends and the document.referrer it shows under every
// policy and delivery, measured against the native run.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-referrer-policy', {
	roots: ['referrer-policy'],
	concurrency: 3,
});
