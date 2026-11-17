// What a page makes locally that no request carried, and which the
// rewriter would never see unless the load of it is routed: blob documents,
// scripts, stylesheets and workers the Blob constructor never saw as such,
// an embed's SVG blob, a data: XHTML document, an xml-stylesheet PI naming
// another site's sheet, raw XML documents and an XSLT's output
// (test/pages/adv-local.html). Any request that reached the network past
// the proxy fails the group.
import { runGroup } from '../adversarial.mjs';

// The checks of this group that fail on purpose, each with its reason
// (test/adversarial.mjs, `knownOpen`): none on Chrome 157 (2026-11-17).
const KNOWN_OPEN = {};

await runGroup('local', {}, { knownOpen: KNOWN_OPEN, bypass: 'fail' });
