// web-platform-tests xhr, the cors share (test/wpt/lists/xhr.mjs):
// the CORS protocol as XMLHttpRequest shows it (preflights, the preflight cache, redirects, credentials, exposed headers),
// measured against the native run.
import { runWpt } from '../wpt.mjs';
import { otherThan, skipped } from '../wpt/lists/xhr.mjs';

await runWpt('wpt-xhr-cors', {
	roots: ['xhr'],
	concurrency: 3,
	globals: ['window', 'dedicatedworker'],
	skip: [otherThan('cors'), ...skipped],
});
