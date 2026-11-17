// The Navigation API across sites (test/pages/adv-navigation.html): a
// navigation to another site cannot be intercepted (canIntercept,
// intercept(), a precommit handler's redirect), and a document of a window
// that went to another site and back sees none of that site's entries
// (entries(), a traversal's navigate event, traverseTo()).
import { runGroup } from '../adversarial.mjs';

// The checks of this group that fail on purpose, each with its reason
// (test/adversarial.mjs, `knownOpen`): none on Chrome 157 (2026-11-17).
const KNOWN_OPEN = {};

await runGroup('navigation', {}, { knownOpen: KNOWN_OPEN });
