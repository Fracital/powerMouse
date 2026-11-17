// web-platform-tests the-script-element/execution-timing
// (test/wpt/html/semantics/scripting-1): the order scripts run in, parser
// inserted, script inserted, async, defer and document.write between them,
// measured against the native run.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-script-timing', {
	roots: ['html/semantics/scripting-1/the-script-element/execution-timing'],
	concurrency: 2,
});
