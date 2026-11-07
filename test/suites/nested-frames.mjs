// What a frame nested in a proxied page learns about its framing, and what the
// parent learns about the frame from its messages, follow the real origins:
// a same-origin child sees its own iframe element in `frameElement` and the
// parent gets the child's real window as `event.source`; a cross-origin child
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
	'a same-origin nested frame sees its iframe element and is the real source of its message',
	same?.frameElement === 'IFRAME#same' &&
		same?.document === 'reachable' &&
		same?.sourceIsFrame === true,
	JSON.stringify(same),
);
ok(
	'a cross-origin nested frame sees no frameElement and is a restricted source',
	cross?.frameElement === null &&
		cross?.document !== 'reachable' &&
		cross?.postMessage === 'function',
	JSON.stringify(cross),
);
await done(browser, page.errors);
