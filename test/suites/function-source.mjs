// Function.prototype.toString and String() of every function a page defines
// read as the page wrote it, byte for byte as natively, not the rewriter's
// output: declarations, expressions, arrows, async functions, generators,
// classes (static blocks and private members), methods, getters and setters,
// computed and quoted keys, nested functions and functions whose bodies the
// rewriter changes (location, top, a computed member, eval, postMessage), in
// an external script (CRLF lines and a raw U+2028 included), a module, an
// inline script and an inline module, handler attributes (parsed and set
// later), eval and indirect eval, new Function and its async and generator
// siblings, a string timer and a dedicated worker. Bound, native and Proxy
// functions keep their native strings. And Google's GSI case: a page puts a
// listener's source in its button frame's URL, and the frame answers 400
// unless it is the source the page wrote. test/pages/function-source.html.bin
// collects every string; the suite compares them with the page loaded
// natively, group by group, in both demo modes.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const PAGE = `${FIXTURE}pages/function-source.html.bin`;
const GROUPS = [
	['ext', 'an external script'],
	['module', 'a module script'],
	['inline', 'an inline script'],
	['inlinemodule', 'an inline module'],
	['handler', 'handler attributes'],
	['eval', 'eval and indirect eval'],
	['function', 'new Function and its siblings'],
	['timer', 'a string timer'],
	['worker', 'a dedicated worker'],
	['native', 'bound, native and Proxy functions'],
];

const browser = await launch();

/** the strings the page collected, once it says everything ran */
async function collect(find) {
	for (let i = 0; i < 160; i++) {
		await sleep(250);
		const frame = await find();
		const value = await frame
			?.evaluate(() => (window.__fnsrcDone ? window.__fnsrc : null))
			.catch(() => null);
		if (value) return value;
	}
	const frame = await find();
	return {
		timedOut: await frame
			?.evaluate(() => ({ left: window.__pending?.left, got: window.__fnsrc }))
			.catch((error) => String(error)),
	};
}

const nativePage = await browser.newPage();
await nativePage.goto(PAGE);
const native = await collect(async () => nativePage.mainFrame());
await nativePage.close();
ok(
	'natively: every group ran',
	!native.timedOut &&
		GROUPS.every(([group]) =>
			Object.keys(native).some((key) => key.startsWith(`${group}:`)),
		) &&
		native['gsi:status'] === 200,
	JSON.stringify(native).slice(0, 400),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, PAGE);
	// routed URLs are encoded: the page's frame is found by its title
	const proxied = await collect(async () => {
		for (const frame of [...page.frames()].reverse())
			if (
				/\/stomp\/[\w-]+\/html\//.test(frame.url()) &&
				(await frame.evaluate(() => document.title).catch(() => '')) ===
					'FUNCTION SOURCE'
			)
				return frame;
		return null;
	});
	for (const [group, label] of GROUPS) {
		const keys = Object.keys(native).filter((key) =>
			key.startsWith(`${group}:`),
		);
		const wrong = keys.filter((key) => proxied[key] !== native[key]);
		ok(
			`${mode}: functions from ${label} read as written (${keys.length - wrong.length}/${keys.length})`,
			!proxied.timedOut && keys.length > 0 && wrong.length === 0,
			proxied.timedOut
				? JSON.stringify(proxied.timedOut).slice(0, 400)
				: wrong
						.slice(0, 3)
						.map(
							(key) =>
								`${key}: ${JSON.stringify(native[key])} -> ${JSON.stringify(proxied[key])}`,
						)
						.join('; ')
						.slice(0, 900),
		);
	}
	ok(
		`${mode}: a listener's source in a frame's URL is the page's (GSI answers 200)`,
		proxied['gsi:status'] === 200,
		JSON.stringify({
			status: proxied['gsi:status'],
			listener: proxied['inline:clickListener'],
		}),
	);
	await page.close();
}
await done(browser);
