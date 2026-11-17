// Another site's storage buckets: a frame of another site lists, opens and
// deletes the buckets of the site that framed it, plainly and with the
// builtins replaced (test/pages/adv-buckets.html with adv-buckets-child.html).
import { runGroup } from '../adversarial.mjs';

// The checks of this group that fail on purpose, each with its reason
// (test/adversarial.mjs, `knownOpen`): none on Chrome 157 (2026-11-17).
const KNOWN_OPEN = {};

await runGroup('buckets', {}, { knownOpen: KNOWN_OPEN });
