// Two platform calls a proxied page makes are accepted and do nothing:
// navigator.registerProtocolHandler (it would register the proxy origin, with
// a prompt naming it; a bad scheme still throws like the browser) and
// console.clear (the console is shared with the host and the rewriter's
// warnings). The Navigation API stays, with its URLs unrouted (readback).
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser);
const consoleTypes = [];
page.on('console', (message) => consoleTypes.push(message.type()));
await submitLanding(page, `${FIXTURE}pages/noops.html`);
let noops = null;
for (let i = 0; i < 40 && !noops?.done; i++) {
	await sleep(250);
	const frame = page
		.frames()
		.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	noops = await frame.evaluate(() => window.__noops).catch(() => null);
}
noops ||= {};
ok(
	'registerProtocolHandler is accepted silently and a bad scheme still throws',
	noops.register === undefined &&
		noops.unregister === undefined &&
		noops.badScheme === 'SecurityError',
	JSON.stringify([noops.register, noops.unregister, noops.badScheme]),
);
ok(
	'console.clear does not clear the console and looks native',
	!consoleTypes.includes('clear') &&
		consoleTypes.includes('log') &&
		/\[native code\]/.test(noops.clearShape || ''),
	JSON.stringify([consoleTypes, noops.clearShape]),
);
await done(browser, page.errors);
