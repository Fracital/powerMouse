// Every sink the browser has, found at run time from its own interfaces
// (test/pages/adv-sinks.html): each element, each interface it can make
// with no arguments and the window's own objects, every method and setter
// given a URL of the page's site, markup, code and a javascript: URL. A
// payload that ran with another top is a leak, and so is any request that
// reached the network without the proxy (a sink whose URL went out as the
// page wrote it), in both demo modes.
import { runGroup } from '../adversarial.mjs';

// The checks of this group that fail on purpose, each with its reason
// (test/adversarial.mjs, `knownOpen`): none on Chrome 156 or 157 (2026-11-16).
// A new failure is a regression to fix, or an entry here that says why not.
const KNOWN_OPEN = {};

await runGroup(
	'sinks',
	{},
	{
		limit: 180000,
		bypass: 'fail',
		knownOpen: KNOWN_OPEN,
	},
);
