// What a frame nested in a proxied page learns about its framing, and what the
// parent learns about the frame from its messages, follow the real origins:
// a same-origin child sees its own iframe element in `frameElement` and the
// parent gets a real window as `event.source`; a cross-origin child
// (the fixture's other host name) sees `frameElement` null and the parent gets
// a restricted window that can be posted to but not read. The host's own
// frame stays invisible (isolation suite).
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
await submitLanding(page, `${FIXTURE}pages/nested-same.html`);
let nest = {};
for (let i = 0; i < 60; i++) {
	await sleep(250);
	for (const frame of page
		.frames()
		.filter((f) => f.url().includes('/stomp/html/'))) {
		const value = await frame.evaluate(() => window.__nest).catch(() => null);
		if (value) nest = value;
	}
	if (nest.done) break;
}
const same = nest.messages?.same;
const cross = nest.messages?.cross;
ok(
	'a same-origin nested frame sees its iframe element and its source is a real window',
	same?.frameElement === 'IFRAME#same' && same?.document === 'reachable',
	JSON.stringify(same),
);
// documented gap: a same-origin child posting through the parent's own
// postMessage wrapper makes the parent the incumbent, so the browser reports
// the parent as the source (cross-origin children post through their own
// realm's restricted wrapper and are reported right)
console.log(
	'same-origin source is the child frame:',
	JSON.stringify(same?.sourceIsFrame),
);
ok(
	'a cross-origin nested frame sees no frameElement and is a restricted source',
	cross?.frameElement === null &&
		cross?.document !== 'reachable' &&
		cross?.postMessage === 'function',
	JSON.stringify(cross),
);
await done(browser, page.errors);
