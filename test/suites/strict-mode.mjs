// A script that opens with 'use strict' stays strict through the rewriter:
// an inline script (whose currentScript restore used to come first), an
// external classic script, a classic worker (whose bootstrap used to come
// first), eval'd code and new Function all throw on an undeclared assignment
// and see `this` undefined in a plain call, as the page's code does.
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
await submitLanding(page, `${FIXTURE}pages/strict.html`);
let strict = {};
for (let i = 0; i < 40; i++) {
	await sleep(250);
	const frame = page.frames().findLast((f) => f.url().includes('/stomp/html/'));
	try {
		strict = (await frame.evaluate(() => window.__strict)) || {};
	} catch (error) {
		strict = {};
	}
	if (strict.done) break;
}
ok(
	'an inline script stays strict',
	strict.inline === 'ReferenceError' && strict.thisInFunction === 'strict',
	JSON.stringify([strict.inline, strict.thisInFunction]),
);
ok(
	'an external classic script stays strict',
	strict.external === 'ReferenceError',
	strict.external,
);
ok(
	'a classic worker stays strict',
	strict.worker === 'ReferenceError',
	strict.worker,
);
ok(
	'eval and new Function code stays strict',
	strict.eval === 'ReferenceError' && strict.fn === 'ReferenceError',
	JSON.stringify([strict.eval, strict.fn]),
);
await done(browser, page.errors);
