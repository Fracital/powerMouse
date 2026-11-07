// web-platform-tests fetch/metadata (test/wpt/fetch/metadata): the
// Sec-Fetch-* headers the proxy sends for each request kind, measured
// against the native run.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-fetch-metadata', {
	roots: ['fetch/metadata'],
	concurrency: 2,
});
