// Storage the browser keys by the real origin, reached past the per-site
// stand-ins (test/pages/adv-storage.html): a StorageAccessHandle's members.
import { runGroup } from '../adversarial.mjs';

// The checks of this group that fail on purpose, each with its reason
// (test/adversarial.mjs, `knownOpen`): none on Chrome 157 (2026-11-17).
// A new failure is a regression to fix, or an entry here that says why not.
const KNOWN_OPEN = {};

await runGroup('storage', {}, { knownOpen: KNOWN_OPEN, bypass: 'fail' });
