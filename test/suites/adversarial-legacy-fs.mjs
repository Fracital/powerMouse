// The legacy sandboxed file system as an escape (test/pages/adv-legacy-fs.html):
// what a cross-site child wrote, the real root above the site's, the proxy
// in a name or a URL, reached by path, by URL, through the natives' own
// getters, from an about:blank child's realm and from a worker, in both
// demo modes.
import { runGroup } from '../adversarial.mjs';

// The checks of this group that fail on purpose, each with its reason
// (test/adversarial.mjs, `knownOpen`): none.
const KNOWN_OPEN = {};

await runGroup('legacy-fs', {}, { limit: 90000, knownOpen: KNOWN_OPEN });
