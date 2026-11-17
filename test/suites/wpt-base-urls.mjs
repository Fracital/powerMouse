// web-platform-tests html/infrastructure/urls/dynamic-changes-to-base-urls
// (test/wpt/html/infrastructure): what a changed <base href> does to the
// URLs elements resolve, measured against the native run.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-base-urls', {
	roots: ['html/infrastructure/urls/dynamic-changes-to-base-urls'],
	concurrency: 1,
});
