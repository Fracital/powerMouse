// Ways to reach an unforgeable without naming it in an expression: aliasing
// destructuring (`const { top: t } = window`), destructuring assignment,
// shorthand patterns, `document.location`, and `opener`. Each must give the
// page the spoofed value, never the real top or the proxy's location.
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
await submitLanding(page, `${FIXTURE}pages/access.html`);

let acc = {};
for (let i = 0; i < 40; i++) {
	await sleep(250);
	const frame = page.frames().findLast((f) => f.url().includes('/stomp/html/'));
	try {
		acc = (await frame.evaluate(() => window.__acc)) || {};
	} catch (error) {
		acc = {};
	}
	if (acc.docLocation !== undefined) break;
}
for (const [key, why] of [
	['alias', 'aliasing destructuring resolves to the spoofed top and location'],
	['assign', 'destructuring assignment resolves to the spoofed top'],
	['shorthand', 'shorthand destructuring resolves to the spoofed top'],
	['opener', 'opener is null for a page that was not opened by script'],
	['docLocation', 'document.location is the spoofed location'],
])
	ok(why, acc[key] === true, JSON.stringify(acc[key]));

await done(
	browser,
	page.errors.filter((e) => !/max cycles/.test(e)),
);
