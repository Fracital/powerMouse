// web-platform-tests workers/modules (test/wpt/workers/modules): module
// workers and their static and dynamic imports (same-origin, another
// origin, blob: and data: URLs, redirects), import.meta.url, the Referer and
// the credentials of each request, measured against the native run.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-workers-modules', {
	roots: ['workers/modules'],
	concurrency: 1,
	globals: ['window', 'dedicatedworker', 'sharedworker'],
});
