// web-platform-tests url/ (test/wpt/url), the script-only half: the URL and
// URLSearchParams interfaces in a window and in a dedicated worker, where
// the proxy hooks the constructors, measured against the native run.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-url', {
	roots: ['url'],
	concurrency: 2,
	globals: ['window', 'dedicatedworker'],
	// the element and navigation tests are wpt-url-elements
	skip: [/^\/url\/(?!.*\.any\.)/],
});
