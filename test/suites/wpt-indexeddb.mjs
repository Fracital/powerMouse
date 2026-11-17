// web-platform-tests IndexedDB/ (test/wpt/IndexedDB), a bounded set of the
// basics: databases opened, upgraded and deleted under the proxy's
// per-origin names, object stores, indexes, records, cursors, key ranges
// and transactions, in a window and in a dedicated worker, measured against
// the native run.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-indexeddb', {
	roots: ['IndexedDB'],
	concurrency: 1,
	globals: ['window', 'dedicatedworker'],
});
