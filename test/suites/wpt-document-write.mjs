// web-platform-tests html/webappapis/dynamic-markup-insertion
// (test/wpt/html/webappapis): document.write, writeln and close through the
// inject's write stream, measured against the native run.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-document-write', {
	roots: ['html/webappapis/dynamic-markup-insertion'],
	concurrency: 2,
});
