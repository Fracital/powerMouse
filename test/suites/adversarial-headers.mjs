// A site's protections that ride in its response headers: a proxied page
// framing another site that refuses to be framed (X-Frame-Options DENY,
// SAMEORIGIN or a conflicting list, frame-ancestors 'self'), which the
// browser would let in once the worker dropped the header
// (test/pages/adv-headers.html).
import { runGroup } from '../adversarial.mjs';

// The checks of this group that fail on purpose, each with its reason
// (test/adversarial.mjs, `knownOpen`): none on Chrome 157 (2026-11-17).
const KNOWN_OPEN = {};

await runGroup('headers', {}, { knownOpen: KNOWN_OPEN, bypass: 'fail' });
