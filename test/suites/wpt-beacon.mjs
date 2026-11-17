// web-platform-tests beacon (test/wpt/beacon): navigator.sendBeacon's
// payload kinds and sizes, its quota, redirects, CORS, and the Content-Type,
// Origin and Referer a beacon carries, measured against the native run.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-beacon', {
	roots: ['beacon'],
	// the quota of beacons in flight is the document's, and the proxy's own
	// synchronous requests share it
	concurrency: 1,
});
