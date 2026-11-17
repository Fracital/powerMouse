// The encrypted event as an escape (test/pages/adv-encrypted-media.html):
// another site's media loaded without CORS read for its init data (key ids)
// in every way a page can, in both demo modes.
import { runGroup } from '../adversarial.mjs';

// The checks of this group that fail on purpose, each with its reason
// (test/adversarial.mjs, `knownOpen`): none.
const KNOWN_OPEN = {};

await runGroup('encrypted-media', {}, { limit: 90000, knownOpen: KNOWN_OPEN });
