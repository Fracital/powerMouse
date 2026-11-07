// web-platform-tests cookies/ (test/wpt/cookies): document.cookie and
// Set-Cookie through the proxy's cookie jar, measured against the native
// run. One page at a time: every test shares the jar and cleans it.
import { runWpt } from '../wpt.mjs';

await runWpt('wpt-cookies', { roots: ['cookies'], concurrency: 1 });
