// Nodes another parser made (DOMParser, Document.parseHTMLUnsafe, an XHR's
// document) that the page adopts or imports into its own document and never
// inserts (test/pages/adv-adopt.html): natively their images and media load
// at once and their handlers run when they fire, so a handler's payload must
// see the proxied top and URL, and no load may reach the network without the
// proxy, in both demo modes.
import { runGroup } from '../adversarial.mjs';

// The checks of this group that fail on purpose, each with its reason
// (test/adversarial.mjs, `knownOpen`): none on Chrome 157 (2026-11-17).
// A new failure is a regression to fix, or an entry here that says why not.
const KNOWN_OPEN = {};

await runGroup('adopt', {}, { bypass: 'fail', knownOpen: KNOWN_OPEN });
