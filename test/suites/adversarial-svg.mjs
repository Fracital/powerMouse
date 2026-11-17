// SVG's legacy xlink:href under any prefix bound to the xlink namespace and
// SMIL animations of an href (test/pages/adv-svg.html): an SVG script's
// source, an SVG link's javascript: URL or destination, and an animated
// href that reaches a link or an image, even one that appears after the
// animation, set every way a page can. A payload that ran with another top
// is a leak, and so is any request that reached the network without the
// proxy, in both demo modes.
import { runGroup } from '../adversarial.mjs';

// The checks of this group that fail on purpose, each with its reason
// (test/adversarial.mjs, `knownOpen`): none on Chrome 157 (2026-11-17).
// A new failure is a regression to fix, or an entry here that says why not.
const KNOWN_OPEN = {};

await runGroup('svg', {}, { bypass: 'fail', knownOpen: KNOWN_OPEN });
