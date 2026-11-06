// Inline scripts a page inserts at runtime must run rewritten: they see the
// spoofed top and the real URL, like the page's own inline scripts. The
// fixture's /dyn page inserts one script per technique and records what it saw.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser, HOST);
await submitLanding(page, `${FIXTURE}dyn`);
await sleep(2500);

const frame = page.frames().find((f) => f.url().includes('/stomp/html/'));
const results = await frame.evaluate(() =>
	Object.fromEntries(
		Object.keys(window)
			.filter((k) => k.startsWith('__r_'))
			.map((k) => [k.slice(4), window[k]]),
	),
);

const REWRITTEN = [
	'inline',
	'textContent',
	'text',
	'textNode',
	'innerHTML',
	'divInnerHTML',
	'insertAdjacentHTML',
	'indirectEval',
	'directEval',
	'Function',
];
for (const key of REWRITTEN) {
	const r = results[key];
	ok(
		`${key} script is rewritten`,
		Array.isArray(r) && r[0] === true && r[1] === `${FIXTURE}dyn`,
		JSON.stringify(r),
	);
}
// known limitation: string timers are not rewritten (CHANGELOG)
console.log('stringTimer (known raw):', JSON.stringify(results.stringTimer));

await done(
	browser,
	page.errors.filter((e) => !/max cycles/.test(e)),
);
