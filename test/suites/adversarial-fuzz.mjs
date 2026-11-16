// The rewriter's differential fuzz in a proxied page
// (test/pages/adv-fuzz.html, test/pages/rewriter-fuzz.js): a payload that
// reads `top` and `location` in every expression slot of every node kind,
// evaluated by the page, in both demo modes. A payload that saw another
// window or location is a leak. The cases are seeded and bounded in time;
// rewriter-unit checks the rewriter's output for all of them, and more
// pairs, without a browser.
import { runGroup } from '../adversarial.mjs';

// The checks of this group that fail on purpose, each with its reason
// (test/adversarial.mjs, `knownOpen`): none on Chrome 156 or 157 (2026-11-16).
// A new failure is a regression to fix, or an entry here that says why not.
const KNOWN_OPEN = {};

await runGroup('fuzz', {}, { knownOpen: KNOWN_OPEN });
