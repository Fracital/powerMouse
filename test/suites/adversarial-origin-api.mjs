// The Origin API as an escape (test/pages/adv-origin-api.html): another
// site's message, link or window taken for the page's own origin, and the
// page's own global or worker read as the proxy's, in both demo modes.
import { runGroup } from '../adversarial.mjs';

// The checks of this group that fail on purpose, each with its reason
// (test/adversarial.mjs, `knownOpen`): none.
const KNOWN_OPEN = {};

await runGroup('origin-api', {}, { limit: 60000, knownOpen: KNOWN_OPEN });
