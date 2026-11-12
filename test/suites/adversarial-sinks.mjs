// Every sink the browser has, found at run time from its own interfaces
// (test/pages/adv-sinks.html): each element, each interface it can make
// with no arguments and the window's own objects, every method and setter
// given a URL of the page's site, markup, code and a javascript: URL. A
// payload that ran with another top is a leak, and so is any request that
// reached the network without the proxy (a sink whose URL went out as the
// page wrote it), in both demo modes.
import { runGroup } from '../adversarial.mjs';

await runGroup('sinks', {}, { limit: 180000, bypass: 'fail' });
