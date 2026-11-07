// Script that does not arrive in a <script>: inline event handler attributes,
// javascript: URLs and string arguments to setTimeout / setInterval all run
// through the rewriter, so they see the spoofed top and the real URL.
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
await submitLanding(page, `${FIXTURE}pages/carriers.html`);

let car = {};
for (let i = 0; i < 40; i++) {
	await sleep(250);
	const frame = page
		.frames()
		.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	try {
		car = (await frame.evaluate(() => window.__car)) || {};
	} catch (error) {
		car = {};
	}
	if (car.handler && car.jsurl && car.timer && car.interval) break;
}
const url = `${FIXTURE}pages/carriers.html`;
ok(
	'inline onclick handler is rewritten',
	car.handler === url,
	JSON.stringify(car.handler),
);
ok(
	'javascript: href is rewritten',
	car.jsurl === url,
	JSON.stringify(car.jsurl),
);
ok(
	'string setTimeout is rewritten',
	car.timer === url,
	JSON.stringify(car.timer),
);
ok(
	'string setInterval is rewritten',
	car.interval === url,
	JSON.stringify(car.interval),
);

await done(
	browser,
	page.errors.filter((e) => !/max cycles/.test(e)),
);
