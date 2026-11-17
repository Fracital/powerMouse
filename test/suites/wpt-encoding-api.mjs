// web-platform-tests encoding/ (test/wpt/encoding), the API half:
// TextDecoder, TextEncoder, TextDecoderStream and TextEncoderStream in a
// window and in a dedicated worker, measured against the native run.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-encoding-api', {
	roots: ['encoding'],
	concurrency: 2,
	globals: ['window', 'dedicatedworker'],
	// the documents whose own encoding matters are wpt-encoding-legacy
	skip: [
		/^\/encoding\/(?!.*\.any\.|streams\/)/,
		// fills a buffer a byte at a time for longer than the harness waits,
		// natively too
		/encodeInto-tail-unmodified/,
	],
});
